/*
 * Kaleidosync Windows audio helper (WASAPI).
 *
 * Emits raw PCM on stdout in the exact format the rest of the app expects:
 *   32-bit float little-endian, 48000 Hz, 2 channels interleaved (L R L R ...).
 *
 * Modes:
 *   --check                  Exit 0 when capture is possible, 1 otherwise.
 *                            Prints a JSON object {"ok":bool,"detail":"..."} on stdout.
 *   --list                   Print a JSON array of capture sources on stdout.
 *   --capture system         Capture the default render endpoint (WASAPI loopback).
 *   --capture pid:<pid>      Capture one process tree (WASAPI process loopback,
 *                            Windows 10 2004 / build 19041 and later).
 *
 * Source ids produced by --list:
 *   "system"      loopback of the default output device (always present)
 *   "pid:<pid>"   loopback of one application's audio
 *
 * Everything else (analysis, bass/treble/BPM, shaders) lives in the shared
 * JavaScript pipeline, so this file only has to produce PCM and source lists.
 *
 * Build (cross-compiled in CI or locally with mingw-w64):
 *   x86_64-w64-mingw32-gcc -O2 -o kaleidosync-wasapi.exe kaleidosync-wasapi.c \
 *     -lole32 -lmmdevapi -lpropsys -luuid
 */

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>
#include <propvarutil.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <io.h>
#include <fcntl.h>

/* ------------------------------------------------------------------ */
/* Process-loopback activation (not declared by mingw-w64 headers)     */
/* ------------------------------------------------------------------ */

#ifndef AUDCLNT_STREAMFLAGS_LOOPBACK
#define AUDCLNT_STREAMFLAGS_LOOPBACK 0x00020000
#endif

#ifndef AUDCLNT_BUFFERFLAGS_SILENT
#define AUDCLNT_BUFFERFLAGS_SILENT 0x00000002
#endif

#ifndef AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY
#define AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY 0x00000001
#endif

typedef enum {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AudioClientActivationType;

typedef enum {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} ProcessLoopbackMode;

typedef struct {
    DWORD TargetProcessId;
    ProcessLoopbackMode ProcessLoopbackMode;
} AudioClientProcessLoopbackParams;

typedef struct {
    AudioClientActivationType ActivationType;
    union {
        AudioClientProcessLoopbackParams ProcessLoopbackParams;
    };
} AudioClientActivationParams;

#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD_Process_Loopback"

/* ------------------------------------------------------------------ */
/* Completion handler for ActivateAudioInterfaceAsync                  */
/* ------------------------------------------------------------------ */

typedef struct {
    const IActivateAudioInterfaceCompletionHandlerVtbl *lpVtbl;
    LONG ref;
    HANDLE done;
} CompletionHandler;

static HRESULT STDMETHODCALLTYPE Completion_QueryInterface(
    IActivateAudioInterfaceCompletionHandler *self, REFIID riid, void **ppv)
{
    if (ppv == NULL) return E_POINTER;
    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &IID_IActivateAudioInterfaceCompletionHandler)) {
        CompletionHandler *me = (CompletionHandler *)self;
        InterlockedIncrement(&me->ref);
        *ppv = self;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE Completion_AddRef(
    IActivateAudioInterfaceCompletionHandler *self)
{
    CompletionHandler *me = (CompletionHandler *)self;
    return (ULONG)InterlockedIncrement(&me->ref);
}

static ULONG STDMETHODCALLTYPE Completion_Release(
    IActivateAudioInterfaceCompletionHandler *self)
{
    CompletionHandler *me = (CompletionHandler *)self;
    LONG remaining = InterlockedDecrement(&me->ref);
    // Deliberately do not free. mmdevapi keeps the handler alive for the
    // duration of the asynchronous activation and may still touch it after
    // ActivateCompleted returns; releasing the last reference here could free
    // it underneath the OS. The helper is a short-lived process, so the OS
    // reclaims the allocation on exit.
    return (ULONG)(remaining < 0 ? 0 : remaining);
}

static HRESULT STDMETHODCALLTYPE Completion_ActivateCompleted(
    IActivateAudioInterfaceCompletionHandler *self,
    IActivateAudioInterfaceAsyncOperation *op)
{
    (void)op;
    CompletionHandler *me = (CompletionHandler *)self;
    if (me->done) SetEvent(me->done);
    return S_OK;
}

static const IActivateAudioInterfaceCompletionHandlerVtbl g_CompletionVtbl = {
    Completion_QueryInterface,
    Completion_AddRef,
    Completion_Release,
    Completion_ActivateCompleted
};

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

static void log_err(const char *message)
{
    fprintf(stderr, "[kaleidosync-wasapi] %s\n", message);
    fflush(stderr);
}

static void log_err_hresult(const char *what, HRESULT hr)
{
    fprintf(stderr, "[kaleidosync-wasapi] %s failed: 0x%08lx\n", what, (unsigned long)hr);
    fflush(stderr);
}

static void print_json_string_n(const char *text, size_t length)
{
    putchar('"');
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)text[i];
        switch (c) {
            case '"':  fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (c < 0x20) printf("\\u%04x", c);
                else putchar(c);
        }
    }
    putchar('"');
}

static char *wide_to_utf8(const WCHAR *wide)
{
    if (!wide) return NULL;
    int needed = WideCharToMultiByte(CP_UTF8, 0, wide, -1, NULL, 0, NULL, NULL);
    if (needed <= 0) return NULL;
    char *out = (char *)malloc((size_t)needed);
    if (!out) return NULL;
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, out, needed, NULL, NULL);
    return out;
}

static char *device_friendly_name(IMMDevice *device)
{
    IPropertyStore *props = NULL;
    if (FAILED(IMMDevice_OpenPropertyStore(device, STGM_READ, &props)) || !props) {
        return NULL;
    }
    PROPVARIANT value;
    PropVariantInit(&value);
    char *name = NULL;
    if (SUCCEEDED(IPropertyStore_GetValue(props, &PKEY_Device_FriendlyName, &value)) &&
        value.vt == VT_LPWSTR && value.pwszVal) {
        name = wide_to_utf8(value.pwszVal);
    }
    PropVariantClear(&value);
    IPropertyStore_Release(props);
    return name;
}

static char *process_image_name(DWORD pid)
{
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (process == NULL) return NULL;

    WCHAR path[1024];
    DWORD size = (DWORD)(sizeof(path) / sizeof(path[0]));
    char *name = NULL;
    if (QueryFullProcessImageNameW(process, 0, path, &size)) {
        char *full = wide_to_utf8(path);
        if (full) {
            char *slash = strrchr(full, '\\');
            char *base = slash ? slash + 1 : full;
            name = strdup(base);
            free(full);
        }
    }
    CloseHandle(process);
    return name;
}

/* ------------------------------------------------------------------ */
/* Source enumeration                                                  */
/* ------------------------------------------------------------------ */

static int is_default_render(IMMDevice *device, IMMDeviceEnumerator *enumerator)
{
    IMMDevice *defaultDevice = NULL;
    HRESULT hr = IMMDeviceEnumerator_GetDefaultAudioEndpoint(
        enumerator, eRender, eConsole, &defaultDevice);
    if (FAILED(hr) || !defaultDevice) return 0;

    LPWSTR id = NULL, defaultId = NULL;
    int same = 0;
    if (SUCCEEDED(IMMDevice_GetId(device, &id)) &&
        SUCCEEDED(IMMDevice_GetId(defaultDevice, &defaultId)) &&
        id && defaultId) {
        same = (wcscmp(id, defaultId) == 0);
    }
    if (id) CoTaskMemFree(id);
    if (defaultId) CoTaskMemFree(defaultId);
    IMMDevice_Release(defaultDevice);
    return same;
}

static int pid_already_listed(const DWORD *pids, int count, DWORD pid)
{
    for (int i = 0; i < count; i++) {
        if (pids[i] == pid) return 1;
    }
    return 0;
}

static void enumerate_process_sessions(IMMDeviceEnumerator *enumerator, int *first)
{
    IMMDevice *defaultDevice = NULL;
    if (FAILED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(
            enumerator, eRender, eConsole, &defaultDevice)) || !defaultDevice) {
        return;
    }

    IAudioSessionManager2 *manager = NULL;
    HRESULT hr = IMMDevice_Activate(
        defaultDevice, &IID_IAudioSessionManager2, CLSCTX_ALL, NULL,
        (void **)&manager);
    IMMDevice_Release(defaultDevice);
    if (FAILED(hr) || !manager) return;

    IAudioSessionEnumerator *sessions = NULL;
    if (SUCCEEDED(IAudioSessionManager2_GetSessionEnumerator(manager, &sessions)) && sessions) {
        int count = 0;
        if (SUCCEEDED(IAudioSessionEnumerator_GetCount(sessions, &count))) {
            DWORD pids[128];
            int pidCount = 0;
            for (int i = 0; i < count && pidCount < (int)(sizeof(pids) / sizeof(pids[0])); i++) {
                IAudioSessionControl *control = NULL;
                if (FAILED(IAudioSessionEnumerator_GetSession(sessions, i, &control)) || !control) {
                    continue;
                }
                IAudioSessionControl2 *control2 = NULL;
                if (SUCCEEDED(IAudioSessionControl_QueryInterface(
                        control, &IID_IAudioSessionControl2, (void **)&control2)) && control2) {
                    DWORD pid = 0;
                    if (SUCCEEDED(IAudioSessionControl2_GetProcessId(control2, &pid)) &&
                        pid != 0 && !pid_already_listed(pids, pidCount, pid)) {
                        pids[pidCount++] = pid;

                        char label[512];
                        char *image = process_image_name(pid);
                        const char *name = image ? image : "Application";
                        snprintf(label, sizeof(label), "%s", name);

                        if (!*first) fputs(",", stdout);
                        *first = 0;
                        fputs("{\"id\":\"pid:", stdout);
                        printf("%lu", (unsigned long)pid);
                        fputs("\",\"name\":", stdout);
                        print_json_string_n(label, strlen(label));
                        fputs(",\"type\":\"application\",\"pid\":", stdout);
                        printf("%lu", (unsigned long)pid);
                        putchar('}');

                        if (image) free(image);
                    }
                    IAudioSessionControl2_Release(control2);
                }
                IAudioSessionControl_Release(control);
            }
        }
        IAudioSessionEnumerator_Release(sessions);
    }
    IAudioSessionManager2_Release(manager);
}

static HRESULT list_sources(void)
{
    IMMDeviceEnumerator *enumerator = NULL;
    HRESULT hr = CoCreateInstance(
        &CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
        &IID_IMMDeviceEnumerator, (void **)&enumerator);
    if (FAILED(hr) || !enumerator) {
        log_err_hresult("CoCreateInstance(MMDeviceEnumerator)", hr);
        return hr;
    }

    IMMDeviceCollection *collection = NULL;
    hr = IMMDeviceEnumerator_EnumAudioEndpoints(
        enumerator, eRender, DEVICE_STATE_ACTIVE, &collection);
    if (FAILED(hr) || !collection) {
        log_err_hresult("EnumAudioEndpoints", hr);
        IMMDeviceEnumerator_Release(enumerator);
        return hr;
    }

    UINT count = 0;
    IMMDeviceCollection_GetCount(collection, &count);

    int first = 1;
    fputs("[", stdout);

    for (UINT i = 0; i < count; i++) {
        IMMDevice *device = NULL;
        if (FAILED(IMMDeviceCollection_Item(collection, i, &device)) || !device) continue;

        char *name = device_friendly_name(device);
        char label[1024];
        snprintf(label, sizeof(label), "%s (System Audio)", name ? name : "Output Device");

        if (!first) fputs(",", stdout);
        first = 0;
        fputs("{\"id\":\"endpoint:", stdout);
        printf("%u", (unsigned int)i);
        fputs("\",\"name\":", stdout);
        print_json_string_n(label, strlen(label));
        fputs(",\"type\":\"monitor\",\"isDefault\":", stdout);
        fputs(is_default_render(device, enumerator) ? "true" : "false", stdout);
        putchar('}');

        if (name) free(name);
        IMMDevice_Release(device);
    }

    enumerate_process_sessions(enumerator, &first);

    fputs("]\n", stdout);
    fflush(stdout);

    IMMDeviceCollection_Release(collection);
    IMMDeviceEnumerator_Release(enumerator);
    return S_OK;
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

static float *g_pcm = NULL;
static size_t g_pcm_capacity = 0;

static int ensure_pcm_capacity(size_t samples)
{
    if (samples <= g_pcm_capacity) return 1;
    size_t capacity = g_pcm_capacity ? g_pcm_capacity : 4096;
    while (capacity < samples) capacity *= 2;
    float *grown = (float *)realloc(g_pcm, capacity * sizeof(float));
    if (!grown) return 0;
    g_pcm = grown;
    g_pcm_capacity = capacity;
    return 1;
}

static void write_silence(UINT32 frames, UINT32 channels)
{
    size_t samples = (size_t)frames * channels;
    if (!ensure_pcm_capacity(samples)) return;
    memset(g_pcm, 0, samples * sizeof(float));
    fwrite(g_pcm, sizeof(float), samples, stdout);
}

static void write_pcm16(const BYTE *data, UINT32 frames, UINT32 channels)
{
    size_t samples = (size_t)frames * channels;
    if (!ensure_pcm_capacity(samples)) return;
    const int16_t *source = (const int16_t *)data;
    for (size_t i = 0; i < samples; i++) {
        g_pcm[i] = (float)source[i] / 32768.0f;
    }
    fwrite(g_pcm, sizeof(float), samples, stdout);
}

static WAVEFORMATEX make_client_format(void)
{
    WAVEFORMATEX format;
    memset(&format, 0, sizeof(format));
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = (WORD)(format.nChannels * (format.wBitsPerSample / 8));
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    return format;
}

static HRESULT capture_loop(IAudioClient *client)
{
    IAudioCaptureClient *capture = NULL;
    HRESULT hr = IAudioClient_GetService(
        client, &IID_IAudioCaptureClient, (void **)&capture);
    if (FAILED(hr) || !capture) {
        log_err_hresult("IAudioClient::GetService(IAudioCaptureClient)", hr);
        return hr;
    }

    WAVEFORMATEX *mix = NULL;
    hr = IAudioClient_GetMixFormat(client, &mix);
    if (SUCCEEDED(hr) && mix) {
        fprintf(stderr, "[kaleidosync-wasapi] endpoint mix format: %lu Hz, %u ch, %u bit\n",
                (unsigned long)mix->nSamplesPerSec, (unsigned int)mix->nChannels,
                (unsigned int)mix->wBitsPerSample);
        CoTaskMemFree(mix);
    }

    DWORD lastDataTick = GetTickCount();

    for (;;) {
        UINT32 nextPacket = 0;
        hr = IAudioCaptureClient_GetNextPacketSize(capture, &nextPacket);
        if (FAILED(hr)) {
            log_err_hresult("IAudioCaptureClient::GetNextPacketSize", hr);
            break;
        }
        if (nextPacket == 0) {
            // WASAPI produces no packets while nothing is playing. Emit
            // matching silence so the analysis pipeline keeps a real-time
            // clock and decays to zero instead of freezing on the last frame.
            DWORD now = GetTickCount();
            if (now - lastDataTick >= 10) {
                DWORD elapsed = now - lastDataTick;
                if (elapsed > 500) elapsed = 500;
                write_silence((UINT32)(((UINT64)elapsed * 48000ULL) / 1000ULL), 2);
                fflush(stdout);
                lastDataTick = now;
            }
            Sleep(5);
            continue;
        }

        BYTE *data = NULL;
        UINT32 frames = 0;
        DWORD flags = 0;
        HRESULT bufferHr = IAudioCaptureClient_GetBuffer(
            capture, &data, &frames, &flags, NULL, NULL);

        if (bufferHr == AUDCLNT_E_BUFFER_TOO_LARGE ||
            bufferHr == AUDCLNT_E_OUT_OF_ORDER) {
            IAudioCaptureClient_ReleaseBuffer(capture, 0);
            continue;
        }
        if (FAILED(bufferHr)) {
            log_err_hresult("IAudioCaptureClient::GetBuffer", bufferHr);
            break;
        }

        if (frames > 0) {
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || data == NULL) {
                write_silence(frames, 2);
            } else {
                write_pcm16(data, frames, 2);
            }
            fflush(stdout);
            lastDataTick = GetTickCount();
        }

        IAudioCaptureClient_ReleaseBuffer(capture, frames);
    }

    IAudioCaptureClient_Release(capture);
    return hr;
}

static HRESULT activate_render_endpoint(IMMDevice *device, IAudioClient **outClient)
{
    IAudioClient *client = NULL;
    HRESULT hr = IMMDevice_Activate(
        device, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&client);
    if (FAILED(hr) || !client) {
        log_err_hresult("IMMDevice::Activate(IAudioClient)", hr);
        return hr ? hr : E_FAIL;
    }

    WAVEFORMATEX format = make_client_format();
    hr = IAudioClient_Initialize(
        client, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        0, 0, &format, NULL);
    if (FAILED(hr)) {
        log_err_hresult("IAudioClient::Initialize(loopback)", hr);
        IAudioClient_Release(client);
        return hr;
    }

    *outClient = client;
    return S_OK;
}

// index < 0 selects the default render endpoint; otherwise the nth active
// endpoint in enumeration order (matching the ids emitted by --list).
static HRESULT start_endpoint_loopback(int index, IAudioClient **outClient)
{
    IMMDeviceEnumerator *enumerator = NULL;
    HRESULT hr = CoCreateInstance(
        &CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
        &IID_IMMDeviceEnumerator, (void **)&enumerator);
    if (FAILED(hr) || !enumerator) return hr ? hr : E_FAIL;

    IMMDevice *device = NULL;
    if (index < 0) {
        hr = IMMDeviceEnumerator_GetDefaultAudioEndpoint(
            enumerator, eRender, eConsole, &device);
    } else {
        IMMDeviceCollection *collection = NULL;
        hr = IMMDeviceEnumerator_EnumAudioEndpoints(
            enumerator, eRender, DEVICE_STATE_ACTIVE, &collection);
        if (SUCCEEDED(hr) && collection) {
            hr = IMMDeviceCollection_Item(collection, (UINT)index, &device);
            IMMDeviceCollection_Release(collection);
        }
    }
    IMMDeviceEnumerator_Release(enumerator);

    if (FAILED(hr) || !device) {
        log_err("no render endpoint available");
        return hr ? hr : E_FAIL;
    }

    hr = activate_render_endpoint(device, outClient);
    IMMDevice_Release(device);
    return hr;
}

static HRESULT start_process_loopback(DWORD pid, IAudioClient **outClient)
{
    AudioClientActivationParams params;
    memset(&params, 0, sizeof(params));
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT prop;
    PropVariantInit(&prop);
    prop.vt = VT_BLOB;
    prop.blob.cbSize = (ULONG)sizeof(params);
    prop.blob.pBlobData = (BYTE *)&params;

    CompletionHandler *handler = (CompletionHandler *)calloc(1, sizeof(CompletionHandler));
    if (!handler) {
        PropVariantClear(&prop);
        return E_OUTOFMEMORY;
    }
    handler->lpVtbl = &g_CompletionVtbl;
    handler->ref = 1;
    handler->done = CreateEvent(NULL, TRUE, FALSE, NULL);

    IActivateAudioInterfaceAsyncOperation *operation = NULL;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IID_IAudioClient,
        &prop, (IActivateAudioInterfaceCompletionHandler *)handler, &operation);
    PropVariantClear(&prop);

    if (FAILED(hr) || !operation) {
        log_err_hresult("ActivateAudioInterfaceAsync(process loopback)", hr);
        return hr ? hr : E_FAIL;
    }

    if (handler->done) {
        WaitForSingleObject(handler->done, 10000);
    }

    HRESULT activateResult = E_FAIL;
    IUnknown *activated = NULL;
    hr = IActivateAudioInterfaceAsyncOperation_GetActivateResult(
        operation, &activateResult, &activated);
    IActivateAudioInterfaceAsyncOperation_Release(operation);

    if (FAILED(hr) || FAILED(activateResult) || !activated) {
        log_err_hresult("IActivateAudioInterfaceAsyncOperation::GetActivateResult",
                        FAILED(activateResult) ? activateResult : hr);
        if (activated) IUnknown_Release(activated);
        return E_FAIL;
    }

    IAudioClient *client = NULL;
    hr = IUnknown_QueryInterface(activated, &IID_IAudioClient, (void **)&client);
    IUnknown_Release(activated);

    if (FAILED(hr) || !client) {
        log_err_hresult("QueryInterface(IAudioClient)", hr);
        return E_FAIL;
    }

    WAVEFORMATEX format = make_client_format();
    hr = IAudioClient_Initialize(
        client, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        0, 0, &format, NULL);
    if (FAILED(hr)) {
        log_err_hresult("IAudioClient::Initialize(process loopback)", hr);
        IAudioClient_Release(client);
        return hr;
    }

    *outClient = client;
    return S_OK;
}

static int check_available(void)
{
    IAudioClient *client = NULL;
    HRESULT hr = start_endpoint_loopback(-1, &client);
    int ok = SUCCEEDED(hr) && client != NULL;
    if (client) {
        IAudioClient_Release(client);
    }
    if (ok) {
        fputs("{\"ok\":true,\"detail\":\"WASAPI loopback available\"}\n", stdout);
    } else {
        fprintf(stdout, "{\"ok\":false,\"detail\":\"WASAPI loopback unavailable: 0x%08lx\"}\n",
                (unsigned long)hr);
    }
    fflush(stdout);
    return ok ? 0 : 1;
}

int main(int argc, char **argv)
{
    SetConsoleOutputCP(CP_UTF8);

    if (argc < 2) {
        log_err("usage: kaleidosync-wasapi --check | --list | --capture <system|pid:N>");
        return 2;
    }

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    const int need_uninit = SUCCEEDED(hr);

    int exitCode = 0;

    if (strcmp(argv[1], "--check") == 0) {
        exitCode = check_available();
    } else if (strcmp(argv[1], "--list") == 0) {
        if (FAILED(list_sources())) {
            fputs("[]\n", stdout);
            exitCode = 1;
        }
    } else if (strcmp(argv[1], "--capture") == 0) {
        if (argc < 3) {
            log_err("--capture requires <system|pid:N|endpoint:N>");
            exitCode = 2;
        } else {
            IAudioClient *client = NULL;
            HRESULT startHr;
            if (strcmp(argv[2], "system") == 0) {
                startHr = start_endpoint_loopback(-1, &client);
            } else if (strncmp(argv[2], "pid:", 4) == 0) {
                DWORD pid = (DWORD)strtoul(argv[2] + 4, NULL, 10);
                if (pid == 0) {
                    log_err("invalid pid in --capture target");
                    exitCode = 2;
                    client = NULL;
                    startHr = E_INVALIDARG;
                } else {
                    startHr = start_process_loopback(pid, &client);
                }
            } else if (strncmp(argv[2], "endpoint:", 9) == 0) {
                long index = strtol(argv[2] + 9, NULL, 10);
                startHr = start_endpoint_loopback((int)index, &client);
            } else {
                log_err("--capture target must be 'system', 'endpoint:<n>' or 'pid:<pid>'");
                exitCode = 2;
                client = NULL;
                startHr = E_INVALIDARG;
            }

            if (exitCode == 0) {
                if (SUCCEEDED(startHr) && client) {
                    _setmode(_fileno(stdout), _O_BINARY);
                    hr = capture_loop(client);
                    IAudioClient_Release(client);
                    if (FAILED(hr)) exitCode = 1;
                } else {
                    exitCode = 1;
                }
            }
        }
    } else {
        log_err("unknown mode");
        exitCode = 2;
    }

    if (g_pcm) free(g_pcm);
    if (need_uninit) CoUninitialize();
    return exitCode;
}