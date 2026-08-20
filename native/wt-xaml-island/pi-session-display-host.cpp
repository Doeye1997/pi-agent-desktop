#include <pch.h>

#include <DispatcherQueue.h>
#include <windows.h>
#include <windows.ui.xaml.hosting.desktopwindowxamlsource.h>

#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.Text.h>
#include <winrt/Windows.UI.Xaml.Controls.h>
#include <winrt/Windows.UI.Xaml.Hosting.h>
#include <winrt/Windows.UI.Xaml.Markup.h>
#include <winrt/Microsoft.Toolkit.Win32.UI.XamlHost.h>
#include <winrt/Microsoft.Terminal.Control.h>
#include <winrt/Microsoft.Terminal.Core.h>
#include <winrt/Microsoft.Terminal.TerminalConnection.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.XamlTypeInfo.h>

#include <DefaultSettings.h>
#include <conattrs.hpp>
#include <til.h>
#include <ControlProperties.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace fs = std::filesystem;

using ProjectedActivationFactory = winrt::Windows::Foundation::IActivationFactory;
using winrt::Windows::Foundation::Collections::IMapView;
using winrt::Windows::Foundation::Collections::ValueSet;
using winrt::Windows::System::DispatcherQueue;
using winrt::Windows::System::DispatcherQueueController;
using winrt::Windows::UI::Xaml::Hosting::DesktopWindowXamlSource;
using winrt::Windows::UI::Xaml::Markup::IXamlMetadataProvider;
using winrt::Microsoft::Toolkit::Win32::UI::XamlHost::XamlApplication;
using winrt::Microsoft::Terminal::Control::IControlAppearance;
using winrt::Microsoft::Terminal::Control::IControlSettings;
using winrt::Microsoft::Terminal::Control::ITermControlFactory;
using winrt::Microsoft::Terminal::Control::TermControl;
using winrt::Microsoft::Terminal::Control::XamlMetaDataProvider;
using winrt::Microsoft::Terminal::TerminalConnection::ConptyConnection;
using winrt::Microsoft::Terminal::TerminalConnection::IConptyConnectionStatics;
using winrt::Microsoft::Terminal::TerminalConnection::ITerminalConnection;
using winrt::Microsoft::UI::Xaml::Controls::XamlControlsResources;
using winrt::Microsoft::UI::Xaml::Controls::ControlsResourcesVersion;
using winrt::Microsoft::UI::Xaml::XamlTypeInfo::XamlControlsXamlMetaDataProvider;

using IFontFeatureMap = winrt::Windows::Foundation::Collections::IMap<winrt::hstring, float>;
using IFontAxesMap = winrt::Windows::Foundation::Collections::IMap<winrt::hstring, float>;

namespace
{
    constexpr std::wstring_view controlClassName = L"Microsoft.Terminal.Control.TermControl";
    constexpr std::wstring_view controlMetadataProviderClassName = L"Microsoft.Terminal.Control.XamlMetaDataProvider";
    constexpr std::wstring_view connectionClassName = L"Microsoft.Terminal.TerminalConnection.ConptyConnection";
    constexpr std::wstring_view xamlControlsMetadataProviderClassName = L"Microsoft.UI.Xaml.XamlTypeInfo.XamlControlsXamlMetaDataProvider";
    constexpr wchar_t sessionHostWindowClassName[] = L"PiAgentDesktop.SessionHostWindow";

    std::mutex outputMutex;
    std::atomic_bool stopRequested = false;

    LRESULT CALLBACK sessionHostWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
    {
        if (message == WM_ERASEBKGND)
        {
            return 1;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }

    void registerSessionHostWindowClass()
    {
        static std::once_flag registration;
        std::call_once(registration, [] {
            WNDCLASSEXW windowClass{};
            windowClass.cbSize = sizeof(windowClass);
            windowClass.style = CS_HREDRAW | CS_VREDRAW;
            windowClass.lpfnWndProc = sessionHostWindowProc;
            windowClass.hInstance = GetModuleHandleW(nullptr);
            windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
            windowClass.lpszClassName = sessionHostWindowClassName;
            if (!RegisterClassExW(&windowClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
            {
                throw std::runtime_error("failed to register session host window class");
            }
        });
    }

    HWND createSessionHostWindow()
    {
        registerSessionHostWindowClass();
        const auto window = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            sessionHostWindowClassName,
            L"",
            WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            1,
            1,
            nullptr,
            nullptr,
            GetModuleHandleW(nullptr),
            nullptr);
        if (!window)
        {
            throw std::runtime_error("failed to create session host window");
        }
        return window;
    }

    void attachSessionHostWindow(HWND window, HWND parentHandle)
    {
        RECT clientRect{};
        if (!GetClientRect(parentHandle, &clientRect))
        {
            throw std::runtime_error("GetClientRect failed for session parent window");
        }

        const auto currentStyle = GetWindowLongPtrW(window, GWL_STYLE);
        SetWindowLongPtrW(window, GWL_STYLE, (currentStyle & ~static_cast<LONG_PTR>(WS_POPUP)) | WS_CHILD);
        SetLastError(ERROR_SUCCESS);
        if (!SetParent(window, parentHandle) && GetLastError() != ERROR_SUCCESS)
        {
            throw std::runtime_error("failed to attach session host window to parent");
        }

        const auto width = std::max(1L, clientRect.right - clientRect.left);
        const auto height = std::max(1L, clientRect.bottom - clientRect.top);
        SetWindowPos(window, nullptr, 0, 0, width, height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    DispatcherQueueController createCurrentDispatcherQueueController()
    {
        DispatcherQueueOptions options{};
        options.dwSize = sizeof(options);
        options.threadType = DQTYPE_THREAD_CURRENT;
        options.apartmentType = DQTAT_COM_STA;

        ABI::Windows::System::IDispatcherQueueController* controllerAbi = nullptr;
        winrt::check_hresult(::CreateDispatcherQueueController(options, &controllerAbi));
        return DispatcherQueueController{ controllerAbi, winrt::take_ownership_from_abi };
    }

    std::wstring utf8ToWide(const std::string& value)
    {
        if (value.empty())
        {
            return {};
        }

        const auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
        if (length <= 0)
        {
            throw std::runtime_error("invalid UTF-8 input");
        }

        std::wstring result(static_cast<size_t>(length), L'\0');
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length);
        return result;
    }

    std::string wideToUtf8(std::wstring_view value)
    {
        if (value.empty())
        {
            return {};
        }

        const auto length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
        if (length <= 0)
        {
            throw std::runtime_error("invalid UTF-16 input");
        }

        std::string result(static_cast<size_t>(length), '\0');
        WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
        return result;
    }

    std::string jsonEscape(const std::string& value)
    {
        std::string result;
        result.reserve(value.size() + 8);
        for (const auto character : value)
        {
            switch (character)
            {
            case '\\':
                result += "\\\\";
                break;
            case '"':
                result += "\\\"";
                break;
            case '\n':
                result += "\\n";
                break;
            case '\r':
                result += "\\r";
                break;
            case '\t':
                result += "\\t";
                break;
            default:
                if (static_cast<unsigned char>(character) < 0x20)
                {
                    result += "\\u00";
                    constexpr char hex[] = "0123456789abcdef";
                    result += hex[(static_cast<unsigned char>(character) >> 4) & 0x0f];
                    result += hex[static_cast<unsigned char>(character) & 0x0f];
                }
                else
                {
                    result += character;
                }
                break;
            }
        }
        return result;
    }

    void emit(const std::string& value)
    {
        std::lock_guard lock(outputMutex);
        std::cout << value << '\n' << std::flush;
    }

    void emitDiagnostic(const std::string& value)
    {
        std::lock_guard lock(outputMutex);
        std::cerr << value << '\n' << std::flush;
    }

    void emitHostError(const std::string& code, const std::string& message)
    {
        emit("{\"type\":\"host-error\",\"code\":\"" + jsonEscape(code) + "\",\"message\":\"" + jsonEscape(message) + "\"}");
    }

    std::string hresultMessage(const winrt::hresult_error& error)
    {
        const auto message = wideToUtf8(error.message().c_str());
        if (!message.empty())
        {
            return message;
        }
        return "WinRT operation failed with HRESULT " + std::to_string(error.code().value);
    }

    winrt::hresult_error withHresultContext(const char* step, const winrt::hresult_error& error)
    {
        return winrt::hresult_error(
            error.code(),
            winrt::hstring(utf8ToWide(std::string(step) + ": " + hresultMessage(error))));
    }

    void emitSessionError(const std::string& sessionId, const std::string& code, const std::string& message)
    {
        emit("{\"type\":\"error\",\"sessionId\":\"" + jsonEscape(sessionId) + "\",\"code\":\"" + jsonEscape(code) + "\",\"message\":\"" + jsonEscape(message) + "\"}");
    }

    void emitMark(const std::string& sessionId, const char* mark)
    {
        emit("{\"type\":\"mark\",\"sessionId\":\"" + jsonEscape(sessionId) + "\",\"mark\":\"" + mark + "\"}");
    }

    class RuntimeModule
    {
    public:
        RuntimeModule() = default;

        RuntimeModule(const RuntimeModule&) = delete;
        RuntimeModule& operator=(const RuntimeModule&) = delete;

        RuntimeModule(RuntimeModule&& other) noexcept : _module(other._module)
        {
            other._module = nullptr;
        }

        RuntimeModule& operator=(RuntimeModule&& other) noexcept
        {
            if (this != &other)
            {
                reset();
                _module = other._module;
                other._module = nullptr;
            }
            return *this;
        }

        ~RuntimeModule()
        {
            reset();
        }

        void keepLoadedForProcessLifetime() noexcept
        {
            // WinRT/XAML may retain process-global objects after Host teardown.
            // Let the Windows loader unload these modules at process exit.
            _module = nullptr;
        }

        static RuntimeModule load(const fs::path& path)
        {
            const auto module = LoadLibraryExW(path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
            if (!module)
            {
                throw std::runtime_error("LoadLibraryEx failed for " + path.string() + ": " + std::to_string(GetLastError()));
            }
            return RuntimeModule(module);
        }

        ProjectedActivationFactory factory(std::wstring_view className) const
        {
            using DllGetActivationFactory = HRESULT(WINAPI*)(HSTRING, ::IActivationFactory**);
            const auto getFactory = reinterpret_cast<DllGetActivationFactory>(GetProcAddress(_module, "DllGetActivationFactory"));
            if (!getFactory)
            {
                throw std::runtime_error("DllGetActivationFactory export is missing");
            }

            const auto classId = winrt::hstring(className);
            winrt::com_ptr<::IActivationFactory> abiFactory;
            const auto classIdAbi = reinterpret_cast<HSTRING>(winrt::get_abi(classId));
            winrt::check_hresult(getFactory(classIdAbi, abiFactory.put()));
            return ProjectedActivationFactory{ abiFactory.detach(), winrt::take_ownership_from_abi };
        }

    private:
        explicit RuntimeModule(HMODULE module) : _module(module)
        {
        }

        void reset() noexcept
        {
            if (_module)
            {
                FreeLibrary(_module);
                _module = nullptr;
            }
        }

        HMODULE _module = nullptr;
    };

    class HostControlSettings : public winrt::implements<HostControlSettings,
                                                          winrt::Microsoft::Terminal::Core::ICoreSettings,
                                                          winrt::Microsoft::Terminal::Control::IControlSettings,
                                                          winrt::Microsoft::Terminal::Core::ICoreAppearance,
                                                          winrt::Microsoft::Terminal::Control::IControlAppearance,
                                                          winrt::Microsoft::Terminal::Core::ICoreScheme>
    {
        std::array<winrt::Microsoft::Terminal::Core::Color, COLOR_TABLE_SIZE> _ColorTable{};

#define SETTINGS_GEN(type, name, ...) WINRT_PROPERTY(type, name, __VA_ARGS__);
        CORE_SETTINGS(SETTINGS_GEN)
        CORE_APPEARANCE_SETTINGS(SETTINGS_GEN)
        CONTROL_SETTINGS(SETTINGS_GEN)
        CONTROL_APPEARANCE_SETTINGS(SETTINGS_GEN)
#undef SETTINGS_GEN

    public:
        HostControlSettings()
        {
            DefaultForeground(til::color{ 0xff, 0xff, 0xff });
            DefaultBackground(til::color{ 0x00, 0x00, 0x00 });
            _FontWeight = winrt::Windows::UI::Text::FontWeight{ DEFAULT_FONT_WEIGHT };
            _FontFeatures = winrt::single_threaded_map<winrt::hstring, float>();
            _FontAxes = winrt::single_threaded_map<winrt::hstring, float>();
        }

        void GetColorTable(winrt::com_array<winrt::Microsoft::Terminal::Core::Color>& table) noexcept
        {
            table = winrt::com_array(_ColorTable.begin(), _ColorTable.end());
        }
    };

    struct SessionRequest
    {
        std::string sessionId;
        std::string sessionPath;
        std::string cwd;
        std::string nodeExecutable;
        std::string program;
        int32_t cols = 120;
        int32_t rows = 30;
    };

    std::string namedString(const winrt::Windows::Data::Json::JsonObject& object, std::wstring_view key, bool required = true)
    {
        const auto value = object.GetNamedString(key, L"");
        if (required && value.empty())
        {
            throw std::runtime_error("missing JSON string field");
        }
        return wideToUtf8(value.c_str());
    }

    int32_t namedDimension(const winrt::Windows::Data::Json::JsonObject& object, std::wstring_view key, int32_t fallback)
    {
        const auto value = object.GetNamedNumber(key, fallback);
        if (!std::isfinite(value) || value < 1 || value > 10'000)
        {
            throw std::runtime_error("invalid terminal dimension");
        }
        return static_cast<int32_t>(value);
    }

    SessionRequest parseSessionRequest(const winrt::Windows::Data::Json::JsonObject& request)
    {
        const auto session = request.GetNamedObject(L"session");
        const auto size = request.GetNamedObject(L"size");
        SessionRequest result;
        result.sessionId = namedString(session, L"sessionId");
        result.sessionPath = namedString(session, L"sessionPath", false);
        result.cwd = namedString(session, L"cwd");
        result.nodeExecutable = namedString(session, L"nodeExecutable");
        result.program = namedString(session, L"program");
        result.cols = namedDimension(size, L"cols", result.cols);
        result.rows = namedDimension(size, L"rows", result.rows);
        return result;
    }

    std::vector<uint8_t> decodeBase64(std::string_view value)
    {
        constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::vector<uint8_t> result;
        uint32_t buffer = 0;
        int bits = 0;
        for (const auto character : value)
        {
            if (character == '=')
            {
                break;
            }
            const auto position = alphabet.find(character);
            if (position == std::string_view::npos)
            {
                continue;
            }
            buffer = (buffer << 6) | static_cast<uint32_t>(position);
            bits += 6;
            if (bits >= 8)
            {
                bits -= 8;
                result.push_back(static_cast<uint8_t>((buffer >> bits) & 0xff));
            }
        }
        return result;
    }

    HWND parseParentWindowHandle(const std::string& encoded)
    {
        if (encoded.empty())
        {
            return nullptr;
        }

        if (encoded.starts_with("0x") || encoded.starts_with("0X"))
        {
            return reinterpret_cast<HWND>(std::stoull(encoded.substr(2), nullptr, 16));
        }

        const auto bytes = decodeBase64(encoded);
        if (!bytes.empty() && bytes.size() <= sizeof(uintptr_t))
        {
            uintptr_t value = 0;
            for (size_t index = 0; index < bytes.size(); ++index)
            {
                value |= static_cast<uintptr_t>(bytes[index]) << (index * 8);
            }
            return reinterpret_cast<HWND>(value);
        }

        return reinterpret_cast<HWND>(std::stoull(encoded, nullptr, 10));
    }

    winrt::guid newGuid()
    {
        GUID value{};
        winrt::check_hresult(CoCreateGuid(&value));
        return winrt::guid{ value };
    }

    std::wstring quoteWindowsArgument(const std::wstring& value)
    {
        std::wstring result = L"\"";
        for (const auto character : value)
        {
            if (character == L'"')
            {
                result += L'\\';
            }
            result += character;
        }
        result += L'"';
        return result;
    }

    std::wstring commandLineFor(const SessionRequest& request)
    {
        std::wstring commandLine = quoteWindowsArgument(utf8ToWide(request.nodeExecutable));
        commandLine += L" ";
        commandLine += quoteWindowsArgument(utf8ToWide(request.program));
        if (!request.sessionPath.empty())
        {
            commandLine += L" --session ";
            commandLine += quoteWindowsArgument(utf8ToWide(request.sessionPath));
        }
        return commandLine;
    }

    class Session
    {
    public:
        Session(SessionRequest sessionRequest, DesktopWindowXamlSource source, HWND hostWindow, HWND islandWindow, winrt::com_ptr<HostControlSettings> settings, TermControl control, ITerminalConnection connection) :
            request(std::move(sessionRequest)),
            id(request.sessionId),
            xamlSource(std::move(source)),
            host(std::move(hostWindow)),
            island(std::move(islandWindow)),
            settingsImpl(std::move(settings)),
            termControl(std::move(control)),
            terminalConnection(std::move(connection))
        {
        }

        ~Session()
        {
            if (termControl && restartRequested.value)
            {
                try
                {
                    termControl.RestartTerminalRequested(restartRequested);
                }
                catch (...)
                {
                }
            }
            if (terminalConnection && stateChanged.value)
            {
                try
                {
                    terminalConnection.StateChanged(stateChanged);
                }
                catch (...)
                {
                }
            }
            try
            {
                termControl.Close();
            }
            catch (...)
            {
            }
            if (xamlSource)
            {
                xamlSource.Content(nullptr);
                xamlSource.Close();
            }
            if (host)
            {
                DestroyWindow(host);
            }
        }

        SessionRequest request;
        std::string id;
        DesktopWindowXamlSource xamlSource{ nullptr };
        HWND host = nullptr;
        HWND island = nullptr;
        winrt::com_ptr<HostControlSettings> settingsImpl;
        TermControl termControl{ nullptr };
        ITerminalConnection terminalConnection{ nullptr };
        winrt::event_token stateChanged{};
        winrt::event_token restartRequested{};
        std::atomic_bool processWatchStarted = false;
    };

    class Host
    {
    public:
        explicit Host(fs::path runtimeRoot) : _runtimeRoot(std::move(runtimeRoot))
        {
            const char* step = "DispatcherQueue initialization";
            try
            {
                step = "runtime DLL loading";
                SetDllDirectoryW(_runtimeRoot.c_str());
                _uiXaml = RuntimeModule::load(_runtimeRoot / L"Microsoft.UI.Xaml.dll");
                _connectionModule = RuntimeModule::load(_runtimeRoot / L"TerminalConnection.dll");
                _controlModule = RuntimeModule::load(_runtimeRoot / L"Microsoft.Terminal.Control.dll");
                step = "XAML metadata provider activation";
                auto metadataProviders = winrt::single_threaded_vector<IXamlMetadataProvider>();
                metadataProviders.Append(
                    _controlModule.factory(controlMetadataProviderClassName).ActivateInstance<XamlMetaDataProvider>());
                metadataProviders.Append(
                    _uiXaml.factory(xamlControlsMetadataProviderClassName).ActivateInstance<XamlControlsXamlMetaDataProvider>());
                step = "XamlApplication initialization";
                _xamlApplication = XamlApplication(metadataProviders);
                step = "WinUI resource activation";
                auto xamlControlsResources = XamlControlsResources{};
                step = "WinUI resource version selection";
                xamlControlsResources.ControlsResourcesVersion(ControlsResourcesVersion::Version2);
                step = "XamlApplication resource access";
                const auto resources = _xamlApplication.Resources();
                step = "XamlApplication resource merge";
                resources.MergedDictionaries().Append(xamlControlsResources);
                step = "DispatcherQueue initialization";
                if (!DispatcherQueue::GetForCurrentThread())
                {
                    _dispatcherController = createCurrentDispatcherQueueController();
                }
            }
            catch (const winrt::hresult_error& error)
            {
                throw withHresultContext(step, error);
            }
        }

        ~Host()
        {
            _sessions.clear();
            _dispatcherController = nullptr;
            if (_xamlApplication)
            {
                _xamlApplication.Close();
                _xamlApplication = nullptr;
            }
            _controlModule.keepLoadedForProcessLifetime();
            _connectionModule.keepLoadedForProcessLifetime();
            _uiXaml.keepLoadedForProcessLifetime();
        }

        void mount(const winrt::Windows::Data::Json::JsonObject& command)
        {
            const auto parentHandle = parseParentWindowHandle(namedString(command, L"parentWindowHandle"));
            if (!parentHandle || !IsWindow(parentHandle))
            {
                throw std::runtime_error("parentWindowHandle is not a live HWND");
            }

            const auto request = parseSessionRequest(command);
            emitDiagnostic(
                "command=mount session=" + request.sessionId +
                " sessionPath=" + request.sessionPath +
                " cwd=" + request.cwd);
            kill(request.sessionId);

            const auto hostWindow = createSessionHostWindow();
            auto source = DesktopWindowXamlSource{};
            const auto interop = source.as<IDesktopWindowXamlSourceNative>();
            try
            {
                winrt::check_hresult(interop->AttachToWindow(hostWindow));
            }
            catch (const winrt::hresult_error& error)
            {
                throw withHresultContext("AttachToWindow", error);
            }
            HWND islandWindow = nullptr;
            try
            {
                winrt::check_hresult(interop->get_WindowHandle(&islandWindow));
            }
            catch (const winrt::hresult_error& error)
            {
                throw withHresultContext("get_WindowHandle", error);
            }
            ShowWindow(islandWindow, SW_HIDE);
            attachSessionHostWindow(hostWindow, parentHandle);

            auto settingsImpl = winrt::make_self<HostControlSettings>();
            auto settings = settingsImpl.as<IControlSettings>();
            settingsImpl->InitialRows(request.rows);
            settingsImpl->InitialCols(request.cols);
            settingsImpl->Commandline(winrt::hstring(commandLineFor(request)));
            settingsImpl->StartingDirectory(winrt::hstring(utf8ToWide(request.cwd)));
            settingsImpl->StartingTitle(winrt::hstring(L"Pi"));
            settingsImpl->SessionId(newGuid());
            settingsImpl->FontFace(winrt::hstring(L"Cascadia Mono"));
            settingsImpl->FontSize(12.0f);

            const auto connection = createConnection(request, settingsImpl->SessionId());

            const auto controlFactory = _controlModule.factory(controlClassName).as<ITermControlFactory>();
            TermControl control{ nullptr };
            try
            {
                control = controlFactory.CreateInstance2(settings, settings, connection);
            }
            catch (const winrt::hresult_error& error)
            {
                throw withHresultContext("TermControl.CreateInstance2", error);
            }
            try
            {
                source.Content(control);
            }
            catch (const winrt::hresult_error& error)
            {
                throw withHresultContext("DesktopWindowXamlSource.Content", error);
            }
            RECT hostRect{};
            GetClientRect(hostWindow, &hostRect);
            SetWindowPos(
                islandWindow,
                nullptr,
                0,
                0,
                std::max(1L, hostRect.right - hostRect.left),
                std::max(1L, hostRect.bottom - hostRect.top),
                SWP_SHOWWINDOW | SWP_NOACTIVATE);

            auto session = std::make_shared<Session>(request, std::move(source), hostWindow, islandWindow, std::move(settingsImpl), control, connection);
            watchConnection(session);
            session->restartRequested = control.RestartTerminalRequested([this, sessionId = request.sessionId](const auto&, const auto&) {
                try
                {
                    restart(sessionId);
                }
                catch (const winrt::hresult_error& error)
                {
                    emitSessionError(sessionId, "RESTART_FAILED", hresultMessage(error));
                }
                catch (const std::exception& error)
                {
                    emitSessionError(sessionId, "RESTART_FAILED", error.what());
                }
            });
            _sessions[request.sessionId] = std::move(session);
        }

        void focus(const std::string& sessionId)
        {
            const auto session = find(sessionId);
            if (!session)
            {
                return;
            }
            SetFocus(session->island);
            BringWindowToTop(session->island);
        }

        void write(const std::string& sessionId, const std::string& data)
        {
            const auto session = find(sessionId);
            if (session)
            {
                session->termControl.SendInput(winrt::hstring(utf8ToWide(data)));
            }
        }

        void resize(const winrt::Windows::Data::Json::JsonObject& command)
        {
            const auto session = find(namedString(command, L"sessionId"));
            if (!session)
            {
                return;
            }
            const auto size = command.GetNamedObject(L"size");
            const auto cols = namedDimension(size, L"cols", 120);
            const auto rows = namedDimension(size, L"rows", 30);
            session->terminalConnection.Resize(static_cast<uint32_t>(rows), static_cast<uint32_t>(cols));
        }

        void bounds(const winrt::Windows::Data::Json::JsonObject& command)
        {
            const auto session = find(namedString(command, L"sessionId"));
            if (!session)
            {
                return;
            }
            const auto bounds = command.GetNamedObject(L"bounds");
            const auto scale = bounds.GetNamedNumber(L"scaleFactor", 1.0);
            const auto x = static_cast<int>(std::lround(bounds.GetNamedNumber(L"x", 0.0) * scale));
            const auto y = static_cast<int>(std::lround(bounds.GetNamedNumber(L"y", 0.0) * scale));
            const auto width = static_cast<int>(std::lround(bounds.GetNamedNumber(L"width", 1.0) * scale));
            const auto height = static_cast<int>(std::lround(bounds.GetNamedNumber(L"height", 1.0) * scale));
            if (width <= 0 || height <= 0)
            {
                return;
            }
            SetWindowPos(session->island, nullptr, x, y, width, height, SWP_SHOWWINDOW | SWP_NOACTIVATE);
        }

        void theme(const winrt::Windows::Data::Json::JsonObject& command)
        {
            const auto themeName = namedString(command, L"theme");
            const auto dark = themeName != "light";
            for (const auto& [sessionId, session] : _sessions)
            {
                session->settingsImpl->DefaultForeground(dark ? til::color{ 0xff, 0xff, 0xff } : til::color{ 0x00, 0x00, 0x00 });
                session->settingsImpl->DefaultBackground(dark ? til::color{ 0x00, 0x00, 0x00 } : til::color{ 0xff, 0xff, 0xff });
                const auto settings = session->settingsImpl.as<IControlSettings>();
                session->termControl.UpdateControlSettings(settings, settings);
            }
        }

        void kill(const std::string& sessionId)
        {
            emitDiagnostic("command=kill session=" + sessionId);
            const auto found = _sessions.find(sessionId);
            if (found == _sessions.end())
            {
                return;
            }
            _sessions.erase(found);
            emitMark(sessionId, "dead");
        }

        void dispose()
        {
            emitDiagnostic("command=dispose");
            _sessions.clear();
            stopRequested = true;
            PostQuitMessage(0);
        }

    private:
        ITerminalConnection createConnection(const SessionRequest& request, const winrt::guid& sessionGuid)
        {
            const auto connectionFactory = _connectionModule.factory(connectionClassName);
            const auto connectionStatics = connectionFactory.as<IConptyConnectionStatics>();
            const auto connectionSettings = connectionStatics.CreateSettings(
                winrt::hstring(commandLineFor(request)),
                winrt::hstring(utf8ToWide(request.cwd)),
                winrt::hstring(L"Pi"),
                false,
                winrt::hstring(L""),
                nullptr,
                static_cast<uint32_t>(request.rows),
                static_cast<uint32_t>(request.cols),
                winrt::guid{},
                winrt::guid{});
            connectionSettings.Insert(
                L"sessionId",
                winrt::Windows::Foundation::PropertyValue::CreateGuid(sessionGuid));
            const auto connection = connectionFactory.ActivateInstance<ConptyConnection>();
            try
            {
                connection.Initialize(connectionSettings);
            }
            catch (const winrt::hresult_error& error)
            {
                throw withHresultContext("ConptyConnection.Initialize", error);
            }
            return connection;
        }

        void watchProcessExit(const std::shared_ptr<Session>& session)
        {
            if (session->processWatchStarted.exchange(true))
            {
                return;
            }

            const auto conpty = session->terminalConnection.try_as<ConptyConnection>();
            const auto sourceHandle = conpty ? reinterpret_cast<HANDLE>(conpty.RootProcessHandle()) : nullptr;
            HANDLE processHandle = nullptr;
            if (!sourceHandle || !DuplicateHandle(
                                     GetCurrentProcess(),
                                     sourceHandle,
                                     GetCurrentProcess(),
                                     &processHandle,
                                     0,
                                     FALSE,
                                     DUPLICATE_SAME_ACCESS))
            {
                session->processWatchStarted = false;
                emitDiagnostic("session=" + session->id + " process-handle-unavailable");
                return;
            }

            const auto processId = GetProcessId(processHandle);
            emitDiagnostic("session=" + session->id + " process-start pid=" + std::to_string(processId));
            std::thread([sessionId = session->id, processId, processHandle]() {
                WaitForSingleObject(processHandle, INFINITE);
                DWORD exitCode = 0;
                if (GetExitCodeProcess(processHandle, &exitCode))
                {
                    emitDiagnostic(
                        "session=" + sessionId +
                        " process-exit pid=" + std::to_string(processId) +
                        " code=" + std::to_string(exitCode));
                }
                CloseHandle(processHandle);
            }).detach();
        }

        void watchConnection(const std::shared_ptr<Session>& session)
        {
            session->stateChanged = session->terminalConnection.StateChanged([this, weakSession = std::weak_ptr<Session>(session)](const auto& sender, const auto&) {
                try
                {
                    const auto state = sender.State();
                    const auto session = weakSession.lock();
                    if (!session)
                    {
                        return;
                    }
                    emitDiagnostic(
                        "session=" + session->id +
                        " connection-state=" + std::to_string(static_cast<int32_t>(state)));
                    if (state == winrt::Microsoft::Terminal::TerminalConnection::ConnectionState::Connected)
                    {
                        watchProcessExit(session);
                        return;
                    }
                    if (state == winrt::Microsoft::Terminal::TerminalConnection::ConnectionState::Closed ||
                        state == winrt::Microsoft::Terminal::TerminalConnection::ConnectionState::Failed)
                    {
                        emitMark(session->id, "dead");
                    }
                }
                catch (...)
                {
                    if (const auto session = weakSession.lock())
                    {
                        emitMark(session->id, "dead");
                    }
                }
            });
        }

        void restart(const std::string& sessionId)
        {
            emitDiagnostic("command=restart session=" + sessionId);
            const auto session = find(sessionId);
            if (!session)
            {
                return;
            }

            const auto connection = createConnection(session->request, newGuid());
            if (session->terminalConnection && session->stateChanged.value)
            {
                session->terminalConnection.StateChanged(session->stateChanged);
                session->stateChanged = {};
            }
            session->termControl.HardResetWithoutErase();
            session->termControl.Connection(connection);
            session->terminalConnection = connection;
            session->processWatchStarted = false;
            watchConnection(session);
            connection.Start();
            emitMark(sessionId, "running");
        }

        std::shared_ptr<Session> find(const std::string& sessionId) const
        {
            const auto found = _sessions.find(sessionId);
            return found == _sessions.end() ? nullptr : found->second;
        }

        fs::path _runtimeRoot;
        RuntimeModule _uiXaml;
        RuntimeModule _connectionModule;
        RuntimeModule _controlModule;
        XamlApplication _xamlApplication{ nullptr };
        DispatcherQueueController _dispatcherController{ nullptr };
        std::unordered_map<std::string, std::shared_ptr<Session>> _sessions;
    };

    fs::path executableDirectory()
    {
        std::wstring buffer(32768, L'\0');
        const auto length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (length == 0)
        {
            throw std::runtime_error("GetModuleFileNameW failed");
        }
        buffer.resize(length);
        return fs::path(buffer).parent_path();
    }

    fs::path runtimeDirectory()
    {
        wchar_t buffer[32768]{};
        const auto length = GetEnvironmentVariableW(L"PI_DESKTOP_WINDOWS_TERMINAL_RUNTIME", buffer, static_cast<DWORD>(std::size(buffer)));
        if (length > 0 && length < std::size(buffer))
        {
            return fs::path(buffer, buffer + length);
        }
        const auto siblingRuntime = executableDirectory() / L"runtime";
        if (fs::exists(siblingRuntime / L"Microsoft.UI.Xaml.dll"))
        {
            return siblingRuntime;
        }
        return executableDirectory();
    }

    void enqueueCommand(const DispatcherQueue& dispatcher, std::string line, Host& host)
    {
        dispatcher.TryEnqueue([line = std::move(line), &host]() {
            try
            {
                const auto command = winrt::Windows::Data::Json::JsonObject::Parse(winrt::hstring(utf8ToWide(line)));
                const auto type = command.GetNamedString(L"type", L"");
                if (type == L"mount")
                {
                    host.mount(command.GetNamedObject(L"request"));
                }
                else if (type == L"focus")
                {
                    host.focus(namedString(command, L"sessionId"));
                }
                else if (type == L"write")
                {
                    host.write(namedString(command, L"sessionId"), namedString(command, L"data", false));
                }
                else if (type == L"resize")
                {
                    host.resize(command);
                }
                else if (type == L"bounds")
                {
                    host.bounds(command);
                }
                else if (type == L"theme")
                {
                    host.theme(command);
                }
                else if (type == L"kill")
                {
                    host.kill(namedString(command, L"sessionId"));
                }
                else if (type == L"dispose")
                {
                    host.dispose();
                }
                else
                {
                    emitHostError("HOST_PROTOCOL_ERROR", "unknown host command");
                }
            }
            catch (const winrt::hresult_error& error)
            {
                emitHostError("HOST_UNAVAILABLE", hresultMessage(error));
            }
            catch (const std::exception& error)
            {
                emitHostError("HOST_PROTOCOL_ERROR", error.what());
            }
        });
    }
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int)
{
    try
    {
        winrt::init_apartment(winrt::apartment_type::single_threaded);
        Host host(runtimeDirectory());
        const auto dispatcher = DispatcherQueue::GetForCurrentThread();
        if (!dispatcher)
        {
            throw std::runtime_error("DispatcherQueue is unavailable");
        }

        std::thread inputThread([dispatcher, &host]() {
            std::string line;
            while (!stopRequested && std::getline(std::cin, line))
            {
                if (!line.empty())
                {
                    enqueueCommand(dispatcher, std::move(line), host);
                }
            }
            if (!stopRequested)
            {
                dispatcher.TryEnqueue([&host]() { host.dispose(); });
            }
        });

        MSG message{};
        while (!stopRequested && GetMessageW(&message, nullptr, 0, 0) > 0)
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        stopRequested = true;
        if (inputThread.joinable())
        {
            inputThread.detach();
        }
        return 0;
    }
    catch (const winrt::hresult_error& error)
    {
        emitHostError("HOST_UNAVAILABLE", hresultMessage(error));
        return 1;
    }
    catch (const std::exception& error)
    {
        emitHostError("HOST_UNAVAILABLE", error.what());
        return 1;
    }
}
