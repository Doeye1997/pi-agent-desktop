#include <pch.h>

#include <DispatcherQueue.h>
#include <windows.h>
#include <windows.ui.xaml.hosting.desktopwindowxamlsource.h>

#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.Text.h>
#include <winrt/Windows.UI.Xaml.h>
#include <winrt/Windows.UI.Xaml.Controls.h>
#include <winrt/Windows.UI.Xaml.Hosting.h>
#include <winrt/Windows.UI.Xaml.Input.h>
#include <winrt/Windows.UI.Xaml.Markup.h>
#include <winrt/Windows.UI.Xaml.Media.h>
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
#include <cwctype>
#include <cstring>
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
using winrt::Windows::System::VirtualKey;
using winrt::Windows::UI::Color;
using winrt::Windows::UI::Xaml::ElementTheme;
using winrt::Windows::UI::Xaml::FocusState;
using winrt::Windows::UI::Xaml::HorizontalAlignment;
using winrt::Windows::UI::Xaml::Thickness;
using winrt::Windows::UI::Xaml::VerticalAlignment;
using winrt::Windows::UI::Xaml::Visibility;
using winrt::Windows::UI::Xaml::GridLength;
using winrt::Windows::UI::Xaml::GridUnitType;
using winrt::Windows::UI::Xaml::Controls::Border;
using winrt::Windows::UI::Xaml::Controls::ColumnDefinition;
using winrt::Windows::UI::Xaml::Controls::ComboBox;
using winrt::Windows::UI::Xaml::Controls::ComboBoxItem;
using winrt::Windows::UI::Xaml::Controls::Grid;
using winrt::Windows::UI::Xaml::Controls::Orientation;
using winrt::Windows::UI::Xaml::Controls::ScrollBarVisibility;
using winrt::Windows::UI::Xaml::Controls::ScrollViewer;
using winrt::Windows::UI::Xaml::Controls::SelectionChangedEventArgs;
using winrt::Windows::UI::Xaml::Controls::StackPanel;
using winrt::Windows::UI::Xaml::Controls::TextBox;
using winrt::Windows::UI::Xaml::Controls::TextBlock;
using winrt::Windows::UI::Xaml::Controls::TextChangedEventArgs;
using winrt::Windows::UI::Xaml::Input::KeyRoutedEventArgs;
using winrt::Windows::UI::Xaml::Input::PointerRoutedEventArgs;
using winrt::Windows::UI::Xaml::Media::SolidColorBrush;
using winrt::Windows::UI::Xaml::Hosting::DesktopWindowXamlSource;
using winrt::Windows::UI::Xaml::Markup::IXamlMetadataProvider;
using winrt::Microsoft::Toolkit::Win32::UI::XamlHost::XamlApplication;
using winrt::Microsoft::Terminal::Control::IControlAppearance;
using winrt::Microsoft::Terminal::Control::IControlSettings;
using winrt::Microsoft::Terminal::Control::ITermControlFactory;
using winrt::Microsoft::Terminal::Control::CopyFormat;
using winrt::Microsoft::Terminal::Control::IKeyBindings;
using winrt::Microsoft::Terminal::Control::KeyChord;
using winrt::Microsoft::Terminal::Control::OpenHyperlinkEventArgs;
using winrt::Microsoft::Terminal::Control::PasteFromClipboardEventArgs;
using winrt::Microsoft::Terminal::Control::TermControl;
using winrt::Microsoft::Terminal::Control::WriteToClipboardEventArgs;
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

    HWND findDescendantWindowByClass(HWND root, const wchar_t* className)
    {
        HWND child = nullptr;
        while ((child = FindWindowExW(root, child, nullptr, nullptr)) != nullptr)
        {
            wchar_t name[256]{};
            if (GetClassNameW(child, name, 256) > 0 && wcscmp(name, className) == 0)
            {
                return child;
            }
            if (const HWND nested = findDescendantWindowByClass(child, className))
            {
                return nested;
            }
        }
        return nullptr;
    }

    HWND findElectronContentWindow(HWND browserWindow)
    {
        if (const HWND render = findDescendantWindowByClass(browserWindow, L"Chrome_RenderWidgetHostHWND"))
        {
            return render;
        }
        if (const HWND widget = findDescendantWindowByClass(browserWindow, L"Chrome_WidgetWin_1"))
        {
            return widget;
        }
        return browserWindow;
    }

    POINT electronContentOrigin(HWND browserWindow)
    {
        POINT origin{};
        const auto contentWindow = findElectronContentWindow(browserWindow);
        if (contentWindow == browserWindow || !IsWindow(contentWindow))
        {
            return origin;
        }
        if (!ClientToScreen(contentWindow, &origin) || !ScreenToClient(browserWindow, &origin))
        {
            return POINT{};
        }
        return origin;
    }

    void attachSessionHostWindow(HWND window, HWND parentHandle)
    {
        const auto currentStyle = GetWindowLongPtrW(window, GWL_STYLE);
        SetWindowLongPtrW(window, GWL_STYLE, (currentStyle & ~static_cast<LONG_PTR>(WS_POPUP)) | WS_CHILD);
        SetLastError(ERROR_SUCCESS);
        if (!SetParent(window, parentHandle) && GetLastError() != ERROR_SUCCESS)
        {
            throw std::runtime_error("failed to attach session host window to parent, error=" + std::to_string(GetLastError()));
        }

        SetWindowPos(window, nullptr, 0, 0, 1, 1, SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
    }

    void detachSessionHostWindow(HWND window, HWND parkingWindow)
    {
        if (!window || !IsWindow(window) || !parkingWindow || !IsWindow(parkingWindow))
        {
            return;
        }
        ShowWindow(window, SW_HIDE);
        const auto currentStyle = GetWindowLongPtrW(window, GWL_STYLE);
        SetWindowLongPtrW(window, GWL_STYLE, (currentStyle & ~static_cast<LONG_PTR>(WS_POPUP)) | WS_CHILD);
        SetLastError(ERROR_SUCCESS);
        if (!SetParent(window, parkingWindow) && GetLastError() != ERROR_SUCCESS)
        {
            throw std::runtime_error("failed to park session host window, error=" + std::to_string(GetLastError()));
        }
        SetWindowPos(window, nullptr, 0, 0, 1, 1, SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
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

    std::wstring foldedWide(std::wstring value)
    {
        std::transform(value.begin(), value.end(), value.begin(), ::towlower);
        return value;
    }

    std::optional<std::wstring> slashQuery(const winrt::hstring& text)
    {
        std::wstring value(text.c_str());
        if (value.empty() || value.front() != L'/')
        {
            return std::nullopt;
        }
        if (value.find(L' ') != std::wstring::npos)
        {
            return std::nullopt;
        }
        return value.substr(1);
    }

    std::pair<std::wstring, std::wstring> splitSkillLabel(const std::wstring& label, const std::wstring& value)
    {
        const auto prefix = value + L" \x2014 ";
        if (!value.empty() && label.starts_with(prefix))
        {
            return { value, label.substr(prefix.size()) };
        }
        if (!value.empty())
        {
            return { value, {} };
        }
        return { label, {} };
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

    void emitAck(const std::string& requestId)
    {
        emit("{\"type\":\"ack\",\"requestId\":\"" + jsonEscape(requestId) + "\"}");
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

    void emitAction(const std::string& sessionId, const char* action, const std::string& value = {})
    {
        auto message = "{\"type\":\"action\",\"sessionId\":\"" + jsonEscape(sessionId) +
                       "\",\"action\":\"" + action + "\"";
        if (!value.empty())
        {
            message += ",\"value\":\"" + jsonEscape(value) + "\"";
        }
        emit(message + "}");
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
        commandLine += L" --tui-mode fullscreen";
        if (!request.sessionPath.empty())
        {
            commandLine += L" --session ";
            commandLine += quoteWindowsArgument(utf8ToWide(request.sessionPath));
        }
        else
        {
            commandLine += L" --session-id ";
            commandLine += quoteWindowsArgument(utf8ToWide(request.sessionId));
        }
        return commandLine;
    }

    bool writeClipboardText(HWND owner, const winrt::hstring& text)
    {
        if (!OpenClipboard(owner))
        {
            return false;
        }

        const auto bytes = (text.size() + 1) * sizeof(wchar_t);
        const auto memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if (!memory)
        {
            CloseClipboard();
            return false;
        }

        const auto destination = GlobalLock(memory);
        if (!destination)
        {
            GlobalFree(memory);
            CloseClipboard();
            return false;
        }

        std::memcpy(destination, text.c_str(), bytes);
        GlobalUnlock(memory);
        EmptyClipboard();
        if (!SetClipboardData(CF_UNICODETEXT, memory))
        {
            GlobalFree(memory);
            CloseClipboard();
            return false;
        }

        CloseClipboard();
        return true;
    }

    std::optional<winrt::hstring> readClipboardText(HWND owner)
    {
        if (!OpenClipboard(owner))
        {
            return std::nullopt;
        }

        const auto memory = GetClipboardData(CF_UNICODETEXT);
        if (!memory)
        {
            CloseClipboard();
            return std::nullopt;
        }

        const auto source = static_cast<const wchar_t*>(GlobalLock(memory));
        if (!source)
        {
            CloseClipboard();
            return std::nullopt;
        }

        const auto text = winrt::hstring(source);
        GlobalUnlock(memory);
        CloseClipboard();
        return text;
    }

    class HostKeyBindings : public winrt::implements<HostKeyBindings, IKeyBindings>
    {
    public:
        explicit HostKeyBindings(TermControl control) : _control(std::move(control))
        {
        }

        bool TryKeyChord(const KeyChord& chord)
        {
            const auto modifiers = chord.Modifiers();
            const auto controlPressed = (modifiers & winrt::Windows::System::VirtualKeyModifiers::Control) !=
                                        winrt::Windows::System::VirtualKeyModifiers::None;
            const auto altPressed = (modifiers & winrt::Windows::System::VirtualKeyModifiers::Menu) !=
                                    winrt::Windows::System::VirtualKeyModifiers::None;
            const auto winPressed = (modifiers & winrt::Windows::System::VirtualKeyModifiers::Windows) !=
                                    winrt::Windows::System::VirtualKeyModifiers::None;
            if (!controlPressed || altPressed || winPressed)
            {
                return false;
            }

            if (chord.Vkey() == static_cast<int32_t>(VirtualKey::C))
            {
                return _control.CopySelectionToClipboard(true, false, false, CopyFormat::None);
            }
            if (chord.Vkey() == static_cast<int32_t>(VirtualKey::V))
            {
                _control.PasteTextFromClipboard();
                return true;
            }
            return false;
        }

        bool IsKeyChordExplicitlyUnbound(const KeyChord&)
        {
            return false;
        }

    private:
        TermControl _control{ nullptr };
    };

    struct DockControls
    {
        Border capsule{ nullptr };
        ComboBox cwd{ nullptr };
        ComboBox worktree{ nullptr };
        TextBlock usage{ nullptr };
        ComboBox model{ nullptr };
        ComboBox thinking{ nullptr };
        TextBlock mcp{ nullptr };
    };

    class Session
    {
    public:
        Session(SessionRequest sessionRequest,
                DesktopWindowXamlSource source,
                HWND hostWindow,
                HWND islandWindow,
                HWND browserWindow,
                winrt::com_ptr<HostControlSettings> settings,
                TermControl control,
                ITerminalConnection connection,
                Grid root,
                Border deadLayer,
                TextBlock deadMessage,
                Border card,
                TextBox input,
                DockControls dock) :
            request(std::move(sessionRequest)),
            id(request.sessionId),
            xamlSource(std::move(source)),
            host(std::move(hostWindow)),
            island(std::move(islandWindow)),
            browserParent(browserWindow),
            settingsImpl(std::move(settings)),
            termControl(std::move(control)),
            terminalConnection(std::move(connection)),
            rootGrid(std::move(root)),
            deadSurface(std::move(deadLayer)),
            deadText(std::move(deadMessage)),
            composerCard(std::move(card)),
            composer(std::move(input)),
            dockControls(std::move(dock))
        {
        }

        ~Session()
        {
            try
            {
                if (composer && composerKeyDown.value)
                {
                    composer.KeyDown(composerKeyDown);
                }
                if (composer && composerKeyUp.value)
                {
                    composer.KeyUp(composerKeyUp);
                }
                if (composer && composerTextChanged.value)
                {
                    composer.TextChanged(composerTextChanged);
                }
                if (dockControls.cwd && cwdSelectionChanged.value)
                {
                    dockControls.cwd.SelectionChanged(cwdSelectionChanged);
                }
                if (dockControls.worktree && worktreeSelectionChanged.value)
                {
                    dockControls.worktree.SelectionChanged(worktreeSelectionChanged);
                }
                if (dockControls.model && modelSelectionChanged.value)
                {
                    dockControls.model.SelectionChanged(modelSelectionChanged);
                }
                if (dockControls.thinking && thinkingSelectionChanged.value)
                {
                    dockControls.thinking.SelectionChanged(thinkingSelectionChanged);
                }
                if (termControl && termPointerPressed.value)
                {
                    termControl.PointerPressed(termPointerPressed);
                }
                if (termControl && writeToClipboard.value)
                {
                    termControl.WriteToClipboard(writeToClipboard);
                }
                if (termControl && pasteFromClipboard.value)
                {
                    termControl.PasteFromClipboard(pasteFromClipboard);
                }
                if (termControl && openHyperlink.value)
                {
                    termControl.OpenHyperlink(openHyperlink);
                }
                if (termControl)
                {
                    termControl.KeyBindings(nullptr);
                }
            }
            catch (...)
            {
            }
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

        void hideSkillPicker()
        {
            skillPickerValues.clear();
            skillActiveIndex = 0;
            if (skillPickerItems)
            {
                skillPickerItems.Children().Clear();
            }
            if (skillPickerChrome)
            {
                skillPickerChrome.Visibility(Visibility::Collapsed);
            }
            else if (skillPicker)
            {
                skillPicker.Visibility(Visibility::Collapsed);
            }
        }

        void paintSkillPicker()
        {
            if (!skillPickerItems)
            {
                return;
            }
            const auto count = skillPickerItems.Children().Size();
            for (uint32_t index = 0; index < count; ++index)
            {
                const auto row = skillPickerItems.Children().GetAt(index).try_as<Border>();
                if (!row)
                {
                    continue;
                }
                const auto active = static_cast<int32_t>(index) == skillActiveIndex;
                row.Background(SolidColorBrush(active ? pickerRowActive : pickerRowIdle));
                row.BorderThickness(Thickness{ 0.0 });
                row.Opacity(1.0);
                const auto stack = row.Child().try_as<StackPanel>();
                if (!stack)
                {
                    continue;
                }
                const auto texts = stack.Children();
                if (texts.Size() > 0)
                {
                    if (const auto name = texts.GetAt(0).try_as<TextBlock>())
                    {
                        name.Foreground(SolidColorBrush(pickerForeground));
                    }
                }
                if (texts.Size() > 1)
                {
                    if (const auto description = texts.GetAt(1).try_as<TextBlock>())
                    {
                        description.Foreground(SolidColorBrush(pickerMuted));
                    }
                }
            }
        }

        void keepComposerFocused()
        {
            if (!composer)
            {
                return;
            }
            composer.Focus(FocusState::Programmatic);
        }

        void refreshSkillPicker()
        {
            if (!skillPicker || !skillPickerItems || !composer)
            {
                return;
            }
            const auto query = slashQuery(composer.Text());
            if (!query || skillChoices.empty())
            {
                hideSkillPicker();
                return;
            }
            const auto needle = foldedWide(*query);
            skillPickerItems.Children().Clear();
            skillPickerValues.clear();
            skillActiveIndex = 0;
            for (const auto& [label, value] : skillChoices)
            {
                const auto wideLabel = utf8ToWide(label);
                const auto wideValue = utf8ToWide(value);
                if (!needle.empty() &&
                    foldedWide(wideLabel).find(needle) == std::wstring::npos &&
                    foldedWide(wideValue).find(needle) == std::wstring::npos)
                {
                    continue;
                }
                const auto index = static_cast<int32_t>(skillPickerValues.size());
                const auto [name, description] = splitSkillLabel(wideLabel, wideValue);
                auto row = Border{};
                row.Padding(Thickness{ 10.0, 7.0, 10.0, 7.0 });
                row.Margin(Thickness{ 0.0, 0.0, 0.0, 2.0 });
                row.CornerRadius(winrt::Windows::UI::Xaml::CornerRadius{ 6.0 });
                row.HorizontalAlignment(HorizontalAlignment::Stretch);
                row.AllowFocusOnInteraction(false);
                auto content = StackPanel{};
                content.Spacing(2.0);
                auto nameText = TextBlock{};
                nameText.Text(winrt::hstring(name));
                nameText.FontFamily(winrt::Windows::UI::Xaml::Media::FontFamily(winrt::hstring(L"Cascadia Mono")));
                nameText.FontSize(13.0);
                nameText.TextWrapping(winrt::Windows::UI::Xaml::TextWrapping::NoWrap);
                nameText.TextTrimming(winrt::Windows::UI::Xaml::TextTrimming::CharacterEllipsis);
                nameText.IsHitTestVisible(false);
                content.Children().Append(nameText);
                if (!description.empty())
                {
                    auto descriptionText = TextBlock{};
                    descriptionText.Text(winrt::hstring(description));
                    descriptionText.FontSize(11.0);
                    descriptionText.TextWrapping(winrt::Windows::UI::Xaml::TextWrapping::NoWrap);
                    descriptionText.TextTrimming(winrt::Windows::UI::Xaml::TextTrimming::CharacterEllipsis);
                    descriptionText.IsHitTestVisible(false);
                    content.Children().Append(descriptionText);
                }
                row.Child(content);
                row.PointerEntered([this, index](const auto&, const auto&) {
                    skillActiveIndex = index;
                    paintSkillPicker();
                });
                row.PointerPressed([this, choice = winrt::hstring(wideValue)](const auto&, const PointerRoutedEventArgs& args) {
                    args.Handled(true);
                    applySkillChoice(choice);
                });
                skillPickerItems.Children().Append(row);
                skillPickerValues.emplace_back(wideValue);
                if (skillPickerValues.size() >= 30)
                {
                    break;
                }
            }
            if (skillPickerValues.empty())
            {
                hideSkillPicker();
                keepComposerFocused();
                return;
            }
            if (skillPickerChrome)
            {
                skillPickerChrome.Visibility(Visibility::Visible);
            }
            if (skillPicker)
            {
                skillPicker.Visibility(Visibility::Visible);
            }
            paintSkillPicker();
            keepComposerFocused();
        }

        void applySkillChoice(const winrt::hstring& value)
        {
            if (!composer || value.empty())
            {
                return;
            }
            composer.Text(value + winrt::hstring(L" "));
            keepComposerFocused();
            composer.Select(composer.Text().size(), 0);
            hideSkillPicker();
        }

        bool applySelectedSkill()
        {
            if (skillPickerValues.empty())
            {
                return false;
            }
            auto index = skillActiveIndex;
            if (index < 0 || index >= static_cast<int32_t>(skillPickerValues.size()))
            {
                index = 0;
            }
            applySkillChoice(skillPickerValues[static_cast<size_t>(index)]);
            return true;
        }

        void moveSkillSelection(int delta)
        {
            if (skillPickerValues.empty())
            {
                return;
            }
            const auto last = static_cast<int32_t>(skillPickerValues.size()) - 1;
            if (skillActiveIndex < 0)
            {
                skillActiveIndex = delta > 0 ? 0 : last;
            }
            else
            {
                skillActiveIndex = std::clamp(skillActiveIndex + delta, 0, last);
            }
            paintSkillPicker();
            if (skillPickerItems && skillActiveIndex >= 0 &&
                skillActiveIndex < static_cast<int32_t>(skillPickerItems.Children().Size()))
            {
                const auto row = skillPickerItems.Children().GetAt(static_cast<uint32_t>(skillActiveIndex)).try_as<Border>();
                if (row)
                {
                    row.StartBringIntoView();
                }
            }
            keepComposerFocused();
        }

        void installComposerHandlers()
        {
            const auto enterDown = std::make_shared<std::atomic_bool>(false);
            composerKeyDown = composer.KeyDown(
                [this, connection = terminalConnection, sessionId = id, enterDown](
                    const winrt::Windows::Foundation::IInspectable& sender,
                    const KeyRoutedEventArgs& args) {
                    const auto key = args.OriginalKey();
                    if (skillPicker && skillPicker.Visibility() == Visibility::Visible)
                    {
                        if (key == VirtualKey::Down)
                        {
                            args.Handled(true);
                            moveSkillSelection(1);
                            return;
                        }
                        if (key == VirtualKey::Up)
                        {
                            args.Handled(true);
                            moveSkillSelection(-1);
                            return;
                        }
                        if (key == VirtualKey::Escape)
                        {
                            args.Handled(true);
                            hideSkillPicker();
                            return;
                        }
                        if (key == VirtualKey::Tab || key == VirtualKey::Enter)
                        {
                            if (applySelectedSkill())
                            {
                                args.Handled(true);
                                return;
                            }
                            if (key == VirtualKey::Tab)
                            {
                                args.Handled(true);
                                return;
                            }
                        }
                    }
                    if (key != VirtualKey::Enter)
                    {
                        return;
                    }
                    args.Handled(true);
                    if (enterDown->exchange(true))
                    {
                        return;
                    }

                    const auto input = sender.as<TextBox>().Text();
                    std::vector<char16_t> payload(input.c_str(), input.c_str() + input.size());
                    payload.push_back(u'\r');
                    try
                    {
                        connection.WriteInput(payload);
                        sender.as<TextBox>().Text(winrt::hstring{});
                        emitDiagnostic("composer submit session=" + sessionId + " chars=" + std::to_string(input.size()));
                    }
                    catch (const winrt::hresult_error& error)
                    {
                        emitDiagnostic("composer submit failed session=" + sessionId + " error=" + hresultMessage(error));
                    }
                    catch (const std::exception& error)
                    {
                        emitDiagnostic("composer submit failed session=" + sessionId + " error=" + std::string(error.what()));
                    }
                });
            composerKeyUp = composer.KeyUp(
                [enterDown](const winrt::Windows::Foundation::IInspectable&, const KeyRoutedEventArgs& args) {
                    if (args.OriginalKey() == VirtualKey::Enter)
                    {
                        enterDown->store(false);
                    }
                });
            termPointerPressed = termControl.PointerPressed(
                [](const winrt::Windows::Foundation::IInspectable& sender, const PointerRoutedEventArgs&) {
                    const auto control = sender.as<TermControl>();
                    control.Focus(FocusState::Pointer);
                });
        }

        void installClipboardHandlers()
        {
            writeToClipboard = termControl.WriteToClipboard(
                [owner = host](const winrt::Windows::Foundation::IInspectable&, const WriteToClipboardEventArgs& args) {
                    writeClipboardText(owner, args.Plain());
                });
            pasteFromClipboard = termControl.PasteFromClipboard(
                [owner = host](const winrt::Windows::Foundation::IInspectable&, const PasteFromClipboardEventArgs& args) {
                    if (const auto text = readClipboardText(owner))
                    {
                        args.HandleClipboardData(*text);
                    }
                });
            keyBindings = winrt::make_self<HostKeyBindings>(termControl);
            termControl.KeyBindings(keyBindings.as<IKeyBindings>());
            openHyperlink = termControl.OpenHyperlink(
                [](const winrt::Windows::Foundation::IInspectable&, const OpenHyperlinkEventArgs& args) {
                    const auto uri = args.Uri();
                    std::wstring normalized(uri.c_str());
                    std::transform(normalized.begin(), normalized.end(), normalized.begin(), ::towlower);
                    if (normalized.starts_with(L"https://") || normalized.starts_with(L"http://") ||
                        normalized.starts_with(L"mailto:"))
                    {
                        ShellExecuteW(nullptr, L"open", uri.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                    }
                });
        }

        void installDockHandlers()
        {
            const auto bindChoice = [this](const ComboBox& combo, winrt::event_token& token, const char* action) {
                token = combo.SelectionChanged(
                    [this, action](const winrt::Windows::Foundation::IInspectable& sender, const SelectionChangedEventArgs&) {
                        if (updatingDock)
                        {
                            return;
                        }
                        const auto comboBox = sender.as<ComboBox>();
                        const auto item = comboBox.SelectedItem().try_as<ComboBoxItem>();
                        if (!item)
                        {
                            return;
                        }
                        const auto value = winrt::unbox_value_or<winrt::hstring>(item.Tag(), {});
                        if (value.empty())
                        {
                            return;
                        }
                        const auto valueUtf8 = wideToUtf8(value.c_str());
                        if (valueUtf8 == "__browse__")
                        {
                            emitAction(id, "browse-cwd");
                            return;
                        }
                        emitAction(id, action, valueUtf8);
                    });
            };
            bindChoice(dockControls.cwd, cwdSelectionChanged, "relocate");
            bindChoice(dockControls.worktree, worktreeSelectionChanged, "relocate");
            bindChoice(dockControls.model, modelSelectionChanged, "model");
            bindChoice(dockControls.thinking, thinkingSelectionChanged, "thinking");
            composerTextChanged = composer.TextChanged(
                [this](const winrt::Windows::Foundation::IInspectable&, const TextChangedEventArgs&) {
                    refreshSkillPicker();
                });
        }

        void applyDockState(const winrt::Windows::Data::Json::JsonObject& state)
        {
            updatingDock = true;
            setChoiceItems(dockControls.cwd, namedString(state, L"cwdLabel", false), state, L"cwdChoices", true);
            const auto worktreeLabel = namedString(state, L"worktreeLabel", false);
            setChoiceItems(dockControls.worktree, worktreeLabel, state, L"worktreeChoices", false);
            const auto worktreeChoiceCount =
                state.HasKey(L"worktreeChoices") ? state.GetNamedArray(L"worktreeChoices").Size() : 0;
            dockControls.worktree.Visibility(
                worktreeLabel.empty() && worktreeChoiceCount == 0 ? Visibility::Collapsed : Visibility::Visible);
            setChoiceItems(dockControls.model, namedString(state, L"modelLabel", false), state, L"modelChoices", false);
            setChoiceItems(
                dockControls.thinking,
                namedString(state, L"thinkingLabel", false),
                state,
                L"thinkingChoices",
                false);
            dockControls.usage.Text(winrt::hstring(utf8ToWide(namedString(state, L"usageLabel", false))));
            dockControls.mcp.Text(winrt::hstring(utf8ToWide(namedString(state, L"mcpLabel", false))));
            skillChoices.clear();
            if (state.HasKey(L"skillChoices"))
            {
                for (const auto& value : state.GetNamedArray(L"skillChoices"))
                {
                    const auto item = value.GetObject();
                    skillChoices.emplace_back(
                        namedString(item, L"label", false),
                        namedString(item, L"value", false));
                }
            }
            updatingDock = false;
            refreshSkillPicker();
        }

        void applyTheme(bool dark)
        {
            const auto background = dark ? Color{ 0xff, 0x0b, 0x0d, 0x10 } : Color{ 0xff, 0xf5, 0xf7, 0xfa };
            const auto barBackground = dark ? Color{ 0xff, 0x1c, 0x1c, 0x1f } : Color{ 0xff, 0xf7, 0xf7, 0xf8 };
            const auto inputBackground = dark ? Color{ 0xff, 0x14, 0x14, 0x15 } : Color{ 0xff, 0xff, 0xff, 0xff };
            const auto foreground = dark ? Color{ 0xff, 0xec, 0xec, 0xec } : Color{ 0xff, 0x1a, 0x1a, 0x1a };
            const auto muted = dark ? Color{ 0xff, 0xa0, 0xa0, 0xa6 } : Color{ 0xff, 0x6b, 0x6b, 0x70 };
            const auto border = dark ? Color{ 0xff, 0x2e, 0x2e, 0x30 } : Color{ 0xff, 0xe6, 0xe6, 0xe6 };

            rootGrid.RequestedTheme(dark ? ElementTheme::Dark : ElementTheme::Light);
            rootGrid.Background(SolidColorBrush(background));
            composerCard.Background(SolidColorBrush(barBackground));
            composerCard.BorderBrush(SolidColorBrush(border));
            composerCard.BorderThickness(Thickness{ 0.0, 1.0, 0.0, 0.0 });
            composer.Background(SolidColorBrush(inputBackground));
            composer.BorderBrush(SolidColorBrush(border));
            composer.Foreground(SolidColorBrush(foreground));
            pickerRowIdle = inputBackground;
            pickerRowActive = dark ? Color{ 0xff, 0x2c, 0x2c, 0x30 } : Color{ 0xff, 0xeb, 0xeb, 0xee };
            pickerForeground = foreground;
            pickerMuted = muted;
            if (skillPickerChrome)
            {
                skillPickerChrome.Background(SolidColorBrush(inputBackground));
                skillPickerChrome.BorderBrush(SolidColorBrush(border));
            }
            if (skillPickerHeaderBar)
            {
                skillPickerHeaderBar.BorderBrush(SolidColorBrush(border));
            }
            if (skillPicker)
            {
                skillPicker.Background(SolidColorBrush(inputBackground));
                skillPicker.BorderThickness(Thickness{ 0.0 });
            }
            if (skillPickerHeaderTitle)
            {
                skillPickerHeaderTitle.Foreground(SolidColorBrush(muted));
            }
            if (skillPickerHeaderHint)
            {
                skillPickerHeaderHint.Foreground(SolidColorBrush(muted));
            }
            paintSkillPicker();
            dockControls.capsule.Background(SolidColorBrush(barBackground));
            dockControls.capsule.BorderBrush(SolidColorBrush(border));
            dockControls.usage.Foreground(SolidColorBrush(muted));
            dockControls.mcp.Foreground(SolidColorBrush(muted));
            deadSurface.Background(SolidColorBrush(background));
            deadText.Foreground(SolidColorBrush(foreground));
        }

        void showDeadSurface(bool visible)
        {
            deadSurface.Visibility(visible ? Visibility::Visible : Visibility::Collapsed);
        }

    private:
        static void setChoiceItems(
            const ComboBox& combo,
            const std::string& currentLabel,
            const winrt::Windows::Data::Json::JsonObject& state,
            std::wstring_view choicesKey,
            bool addBrowse)
        {
            combo.Items().Clear();
            int32_t selectedIndex = -1;
            if (state.HasKey(choicesKey))
            {
                for (const auto& value : state.GetNamedArray(choicesKey))
                {
                    const auto choice = value.GetObject();
                    const auto label = namedString(choice, L"label", false);
                    auto item = ComboBoxItem{};
                    item.Content(winrt::box_value(winrt::hstring(utf8ToWide(label))));
                    item.Tag(winrt::box_value(winrt::hstring(utf8ToWide(namedString(choice, L"value", false)))));
                    combo.Items().Append(item);
                    if (selectedIndex < 0 && !currentLabel.empty() && label == currentLabel)
                    {
                        selectedIndex = static_cast<int32_t>(combo.Items().Size() - 1);
                    }
                }
            }
            if (selectedIndex < 0 && !currentLabel.empty())
            {
                auto current = ComboBoxItem{};
                current.Content(winrt::box_value(winrt::hstring(utf8ToWide(currentLabel))));
                current.Tag(winrt::box_value(winrt::hstring{}));
                combo.Items().InsertAt(0, current);
                selectedIndex = 0;
            }
            if (addBrowse)
            {
                auto browse = ComboBoxItem{};
                browse.Content(winrt::box_value(winrt::hstring(L"Browse…")));
                browse.Tag(winrt::box_value(winrt::hstring(L"__browse__")));
                combo.Items().Append(browse);
            }
            if (selectedIndex >= 0)
            {
                combo.SelectedIndex(selectedIndex);
            }
        }

    public:

        SessionRequest request;
        std::string id;
        DesktopWindowXamlSource xamlSource{ nullptr };
        HWND host = nullptr;
        HWND island = nullptr;
        HWND browserParent = nullptr;
        winrt::com_ptr<HostControlSettings> settingsImpl;
        TermControl termControl{ nullptr };
        ITerminalConnection terminalConnection{ nullptr };
        Grid rootGrid{ nullptr };
        Border deadSurface{ nullptr };
        TextBlock deadText{ nullptr };
        Border composerCard{ nullptr };
        TextBox composer{ nullptr };
        Border skillPickerChrome{ nullptr };
        Border skillPickerHeaderBar{ nullptr };
        TextBlock skillPickerHeaderTitle{ nullptr };
        TextBlock skillPickerHeaderHint{ nullptr };
        ScrollViewer skillPicker{ nullptr };
        StackPanel skillPickerItems{ nullptr };
        std::vector<winrt::hstring> skillPickerValues;
        int32_t skillActiveIndex = 0;
        Color pickerRowIdle{};
        Color pickerRowActive{};
        Color pickerForeground{};
        Color pickerMuted{};
        DockControls dockControls;
        winrt::event_token stateChanged{};
        winrt::event_token restartRequested{};
        winrt::event_token composerKeyDown{};
        winrt::event_token composerKeyUp{};
        winrt::event_token composerTextChanged{};
        winrt::event_token cwdSelectionChanged{};
        winrt::event_token worktreeSelectionChanged{};
        winrt::event_token modelSelectionChanged{};
        winrt::event_token thinkingSelectionChanged{};
        winrt::event_token termPointerPressed{};
        winrt::event_token writeToClipboard{};
        winrt::event_token pasteFromClipboard{};
        winrt::event_token openHyperlink{};
        winrt::com_ptr<HostKeyBindings> keyBindings;
        std::vector<std::pair<std::string, std::string>> skillChoices;
        bool updatingDock = false;
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
                _parkingWindow = createSessionHostWindow();
            }
            catch (const winrt::hresult_error& error)
            {
                throw withHresultContext(step, error);
            }
        }

        ~Host()
        {
            _sessions.clear();
            if (_parkingWindow)
            {
                DestroyWindow(_parkingWindow);
                _parkingWindow = nullptr;
            }
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
            if (find(request.sessionId))
            {
                const auto session = find(request.sessionId);
                ensureSessionHostWindow(session, parentHandle);
                focus(request.sessionId);
                return;
            }
            for (const auto& [existingId, existing] : _sessions)
            {
                ShowWindow(existing->host, SW_HIDE);
            }

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
            settingsImpl->DetectURLs(true);

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
            auto root = Grid{};
            root.HorizontalAlignment(HorizontalAlignment::Stretch);
            root.VerticalAlignment(VerticalAlignment::Stretch);
            root.Children().Append(control);

            auto deadSurface = Border{};
            deadSurface.HorizontalAlignment(HorizontalAlignment::Stretch);
            deadSurface.VerticalAlignment(VerticalAlignment::Stretch);
            deadSurface.IsHitTestVisible(false);
            deadSurface.Visibility(Visibility::Collapsed);
            auto deadText = TextBlock{};
            deadText.Text(winrt::hstring(L"Pi exited. Click the terminal and press Enter to restart."));
            deadText.HorizontalAlignment(HorizontalAlignment::Center);
            deadText.VerticalAlignment(VerticalAlignment::Center);
            deadText.FontSize(14.0);
            deadText.TextWrapping(winrt::Windows::UI::Xaml::TextWrapping::Wrap);
            deadSurface.Child(deadText);
            root.Children().Append(deadSurface);

            auto composerCard = Border{};
            composerCard.HorizontalAlignment(HorizontalAlignment::Stretch);
            composerCard.VerticalAlignment(VerticalAlignment::Bottom);
            composerCard.Margin(Thickness{ 0.0, 0.0, 0.0, 0.0 });
            composerCard.Padding(Thickness{ 12.0, 10.0, 12.0, 10.0 });
            composerCard.CornerRadius(winrt::Windows::UI::Xaml::CornerRadius{ 0.0, 0.0, 0.0, 0.0 });

            auto composer = TextBox{};
            composer.HorizontalAlignment(HorizontalAlignment::Stretch);
            composer.VerticalAlignment(VerticalAlignment::Center);
            composer.Height(52.0);
            composer.AcceptsReturn(false);
            composer.IsSpellCheckEnabled(false);
            composer.PlaceholderText(winrt::hstring(L"Message Pi"));
            composer.FontFamily(winrt::Windows::UI::Xaml::Media::FontFamily(winrt::hstring(L"Cascadia Mono")));
            composer.FontSize(14.0);
            composer.Padding(Thickness{ 12.0, 8.0, 12.0, 8.0 });

            auto skillPickerItems = StackPanel{};
            skillPickerItems.HorizontalAlignment(HorizontalAlignment::Stretch);
            auto skillPicker = ScrollViewer{};
            skillPicker.MaxHeight(240.0);
            skillPicker.AllowFocusOnInteraction(false);
            skillPicker.IsTabStop(false);
            skillPicker.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
            skillPicker.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);
            skillPicker.Content(skillPickerItems);

            auto skillPickerHeaderTitle = TextBlock{};
            skillPickerHeaderTitle.Text(winrt::hstring(L"Skills"));
            skillPickerHeaderTitle.FontSize(11.0);
            skillPickerHeaderTitle.VerticalAlignment(VerticalAlignment::Center);
            auto skillPickerHeaderHint = TextBlock{};
            skillPickerHeaderHint.Text(winrt::hstring(L"Tab / Enter"));
            skillPickerHeaderHint.FontSize(11.0);
            skillPickerHeaderHint.FontFamily(winrt::Windows::UI::Xaml::Media::FontFamily(winrt::hstring(L"Cascadia Mono")));
            skillPickerHeaderHint.VerticalAlignment(VerticalAlignment::Center);
            auto headerRow = Grid{};
            auto headerMain = ColumnDefinition{};
            headerMain.Width(GridLength{ 1.0, GridUnitType::Star });
            auto headerHint = ColumnDefinition{};
            headerHint.Width(GridLength{ 1.0, GridUnitType::Auto });
            headerRow.ColumnDefinitions().Append(headerMain);
            headerRow.ColumnDefinitions().Append(headerHint);
            Grid::SetColumn(skillPickerHeaderHint, 1);
            headerRow.Children().Append(skillPickerHeaderTitle);
            headerRow.Children().Append(skillPickerHeaderHint);
            auto headerBar = Border{};
            headerBar.Padding(Thickness{ 10.0, 6.0, 10.0, 8.0 });
            headerBar.BorderThickness(Thickness{ 0.0, 0.0, 0.0, 1.0 });
            headerBar.Child(headerRow);
            headerBar.AllowFocusOnInteraction(false);

            auto chromeStack = StackPanel{};
            chromeStack.Children().Append(headerBar);
            chromeStack.Children().Append(skillPicker);
            auto skillPickerChrome = Border{};
            skillPickerChrome.CornerRadius(winrt::Windows::UI::Xaml::CornerRadius{ 8.0 });
            skillPickerChrome.BorderThickness(Thickness{ 1.0 });
            skillPickerChrome.Padding(Thickness{ 4.0, 2.0, 4.0, 4.0 });
            skillPickerChrome.Visibility(Visibility::Collapsed);
            skillPickerChrome.AllowFocusOnInteraction(false);
            skillPickerChrome.Child(chromeStack);

            const auto createDockCombo = [](double minWidth) {
                auto combo = ComboBox{};
                combo.MinWidth(minWidth);
                combo.Height(28.0);
                combo.MaxDropDownHeight(420.0);
                combo.FontSize(12.0);
                combo.Margin(Thickness{ 0.0, 0.0, 8.0, 0.0 });
                combo.VerticalAlignment(VerticalAlignment::Center);
                return combo;
            };
            auto cwdCombo = createDockCombo(96.0);
            cwdCombo.PlaceholderText(winrt::hstring(L"Folder"));
            auto worktreeCombo = createDockCombo(140.0);
            worktreeCombo.PlaceholderText(winrt::hstring(L"Worktree"));
            auto modelCombo = createDockCombo(128.0);
            modelCombo.PlaceholderText(winrt::hstring(L"Model"));
            auto thinkingCombo = createDockCombo(88.0);
            thinkingCombo.PlaceholderText(winrt::hstring(L"Thinking"));
            auto usageText = TextBlock{};
            usageText.Text(winrt::hstring(L"Usage —"));
            usageText.VerticalAlignment(VerticalAlignment::Center);
            usageText.Margin(Thickness{ 0.0, 0.0, 8.0, 0.0 });
            usageText.FontSize(12.0);
            usageText.TextWrapping(winrt::Windows::UI::Xaml::TextWrapping::Wrap);
            auto mcpText = TextBlock{};
            mcpText.Text(winrt::hstring(L"MCP"));
            mcpText.VerticalAlignment(VerticalAlignment::Center);
            mcpText.FontSize(12.0);

            auto dockRow = Grid{};
            const auto addColumn = [&dockRow](GridUnitType type) {
                auto column = ColumnDefinition{};
                column.Width(GridLength{ 1.0, type });
                dockRow.ColumnDefinitions().Append(column);
            };
            addColumn(GridUnitType::Auto);
            addColumn(GridUnitType::Auto);
            addColumn(GridUnitType::Star);
            addColumn(GridUnitType::Auto);
            addColumn(GridUnitType::Auto);
            addColumn(GridUnitType::Auto);
            Grid::SetColumn(cwdCombo, 0);
            Grid::SetColumn(worktreeCombo, 1);
            Grid::SetColumn(usageText, 2);
            Grid::SetColumn(modelCombo, 3);
            Grid::SetColumn(thinkingCombo, 4);
            Grid::SetColumn(mcpText, 5);
            dockRow.Children().Append(cwdCombo);
            dockRow.Children().Append(worktreeCombo);
            dockRow.Children().Append(usageText);
            dockRow.Children().Append(modelCombo);
            dockRow.Children().Append(thinkingCombo);
            dockRow.Children().Append(mcpText);

            auto dockCapsule = Border{};
            dockCapsule.HorizontalAlignment(HorizontalAlignment::Stretch);
            dockCapsule.Padding(Thickness{ 0.0, 0.0, 0.0, 0.0 });
            dockCapsule.CornerRadius(winrt::Windows::UI::Xaml::CornerRadius{ 0.0, 0.0, 0.0, 0.0 });
            dockCapsule.BorderThickness(Thickness{ 0.0, 0.0, 0.0, 0.0 });
            dockCapsule.Child(dockRow);

            auto composerStack = StackPanel{};
            composerStack.Orientation(Orientation::Vertical);
            composerStack.Spacing(8.0);
            composerStack.Children().Append(skillPickerChrome);
            composerStack.Children().Append(composer);
            composerStack.Children().Append(dockCapsule);
            composerCard.Child(composerStack);
            root.Children().Append(composerCard);

            try
            {
                source.Content(root);
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

            auto session = std::make_shared<Session>(
                request,
                std::move(source),
                hostWindow,
                islandWindow,
                parentHandle,
                std::move(settingsImpl),
                control,
                connection,
                root,
                deadSurface,
                deadText,
                composerCard,
                composer,
                DockControls{
                    dockCapsule,
                    cwdCombo,
                    worktreeCombo,
                    usageText,
                    modelCombo,
                    thinkingCombo,
                    mcpText });
            session->skillPickerChrome = skillPickerChrome;
            session->skillPickerHeaderBar = headerBar;
            session->skillPickerHeaderTitle = skillPickerHeaderTitle;
            session->skillPickerHeaderHint = skillPickerHeaderHint;
            session->skillPicker = skillPicker;
            session->skillPickerItems = skillPickerItems;
            session->applyTheme(_darkTheme);
            session->installComposerHandlers();
            session->installClipboardHandlers();
            session->installDockHandlers();
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
            for (const auto& [candidateId, candidate] : _sessions)
            {
                ShowWindow(candidate->host, candidateId == sessionId ? SW_SHOW : SW_HIDE);
            }
            SetFocus(session->island);
            session->termControl.Focus(FocusState::Programmatic);
            BringWindowToTop(session->host);
        }

        void attach(const std::string& encodedParentHandle)
        {
            const auto parentHandle = parseParentWindowHandle(encodedParentHandle);
            if (!parentHandle || !IsWindow(parentHandle))
            {
                throw std::runtime_error("parentWindowHandle is not a live HWND");
            }
            for (const auto& [sessionId, session] : _sessions)
            {
                ensureSessionHostWindow(session, parentHandle);
                ShowWindow(session->host, SW_HIDE);
            }
            emitDiagnostic("command=attach sessions=" + std::to_string(_sessions.size()));
        }

        void detach()
        {
            for (const auto& [sessionId, session] : _sessions)
            {
                detachSessionHostWindow(session->host, _parkingWindow);
                session->browserParent = nullptr;
            }
            emitDiagnostic("command=detach sessions=" + std::to_string(_sessions.size()));
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
            const auto parentWindow = session->browserParent ? session->browserParent : GetParent(session->host);
            if (parentWindow && GetParent(session->host) != parentWindow)
            {
                SetLastError(ERROR_SUCCESS);
                if (!SetParent(session->host, parentWindow) && GetLastError() != ERROR_SUCCESS)
                {
                    throw std::runtime_error("failed to attach session host window to Electron browser HWND");
                }
            }
            const auto contentOrigin = session->browserParent ? electronContentOrigin(session->browserParent) : POINT{};
            for (const auto& [candidateId, candidate] : _sessions)
            {
                ShowWindow(candidate->host, candidateId == session->id ? SW_SHOW : SW_HIDE);
            }
            SetWindowPos(
                session->host,
                HWND_TOP,
                x + contentOrigin.x,
                y + contentOrigin.y,
                width,
                height,
                SWP_SHOWWINDOW | SWP_NOACTIVATE);
            SetWindowPos(session->island, nullptr, 0, 0, width, height, SWP_SHOWWINDOW | SWP_NOACTIVATE);
        }

        void theme(const winrt::Windows::Data::Json::JsonObject& command)
        {
            const auto themeName = namedString(command, L"theme");
            const auto dark = themeName != "light";
            _darkTheme = dark;
            for (const auto& [sessionId, session] : _sessions)
            {
                session->settingsImpl->DefaultForeground(dark ? til::color{ 0xff, 0xff, 0xff } : til::color{ 0x00, 0x00, 0x00 });
                session->settingsImpl->DefaultBackground(dark ? til::color{ 0x00, 0x00, 0x00 } : til::color{ 0xff, 0xff, 0xff });
                const auto settings = session->settingsImpl.as<IControlSettings>();
                session->termControl.UpdateControlSettings(settings, settings);
                session->applyTheme(dark);
            }
        }

        void dock(const winrt::Windows::Data::Json::JsonObject& command)
        {
            const auto session = find(namedString(command, L"sessionId"));
            if (session)
            {
                session->applyDockState(command.GetNamedObject(L"state"));
            }
        }

        void hide(const std::string& sessionId)
        {
            const auto session = find(sessionId);
            if (session)
            {
                ShowWindow(session->host, SW_HIDE);
            }
        }

        void dead(const std::string& sessionId)
        {
            const auto session = find(sessionId);
            if (session)
            {
                session->showDeadSurface(true);
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
        void ensureSessionHostWindow(const std::shared_ptr<Session>& session, HWND parentHandle)
        {
            if (session->host && IsWindow(session->host))
            {
                attachSessionHostWindow(session->host, parentHandle);
                session->browserParent = parentHandle;
                return;
            }

            emitDiagnostic("session=" + session->id + " rebuilding-window-after-parent-exit");
            if (session->xamlSource)
            {
                try
                {
                    session->xamlSource.Content(nullptr);
                    session->xamlSource.Close();
                }
                catch (...)
                {
                    // The old XAML source can already be invalid after Windows destroys its parent HWND.
                }
            }

            const auto hostWindow = createSessionHostWindow();
            auto source = DesktopWindowXamlSource{};
            const auto interop = source.as<IDesktopWindowXamlSourceNative>();
            HWND islandWindow = nullptr;
            try
            {
                winrt::check_hresult(interop->AttachToWindow(hostWindow));
                winrt::check_hresult(interop->get_WindowHandle(&islandWindow));
                ShowWindow(islandWindow, SW_HIDE);
                attachSessionHostWindow(hostWindow, parentHandle);
                source.Content(session->rootGrid);
            }
            catch (...)
            {
                try
                {
                    source.Content(nullptr);
                    source.Close();
                }
                catch (...)
                {
                }
                DestroyWindow(hostWindow);
                throw;
            }

            RECT hostRect{};
            GetClientRect(hostWindow, &hostRect);
            SetWindowPos(
                islandWindow,
                nullptr,
                0,
                0,
                hostRect.right - hostRect.left,
                hostRect.bottom - hostRect.top,
                SWP_NOZORDER | SWP_NOACTIVATE);
            session->xamlSource = std::move(source);
            session->host = hostWindow;
            session->island = islandWindow;
            session->browserParent = parentHandle;
        }

        ITerminalConnection createConnection(const SessionRequest& request, const winrt::guid& sessionGuid)
        {
            const auto connectionFactory = _connectionModule.factory(connectionClassName);
            const auto connectionStatics = connectionFactory.as<IConptyConnectionStatics>();
            const auto environment = winrt::single_threaded_map<winrt::hstring, winrt::hstring>();
            environment.Insert(L"TERM", L"xterm-256color");
            environment.Insert(L"COLORTERM", L"truecolor");
            const auto connectionSettings = connectionStatics.CreateSettings(
                winrt::hstring(commandLineFor(request)),
                winrt::hstring(utf8ToWide(request.cwd)),
                winrt::hstring(L"Pi"),
                false,
                winrt::hstring(L""),
                environment.GetView(),
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
            session->showDeadSurface(false);
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
        HWND _parkingWindow = nullptr;
        bool _darkTheme = true;
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

    bool isInvalidParentWindowFailure(const winrt::hstring& type)
    {
        return type == L"attach" || type == L"bounds";
    }

    void enqueueCommand(const DispatcherQueue& dispatcher, std::string line, Host& host)
    {
        dispatcher.TryEnqueue([line = std::move(line), &host]() {
            winrt::hstring type;
            try
            {
                const auto command = winrt::Windows::Data::Json::JsonObject::Parse(winrt::hstring(utf8ToWide(line)));
                type = command.GetNamedString(L"type", L"");
                if (type == L"mount")
                {
                    host.mount(command.GetNamedObject(L"request"));
                }
                else if (type == L"attach")
                {
                    host.attach(namedString(command, L"parentWindowHandle"));
                }
                else if (type == L"detach")
                {
                    host.detach();
                    emitAck(namedString(command, L"requestId"));
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
                else if (type == L"dock")
                {
                    host.dock(command);
                }
                else if (type == L"hide")
                {
                    host.hide(namedString(command, L"sessionId"));
                }
                else if (type == L"dead")
                {
                    host.dead(namedString(command, L"sessionId"));
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
                emitHostError(
                    isInvalidParentWindowFailure(type) ? "INVALID_PARENT_WINDOW" : "HOST_UNAVAILABLE",
                    hresultMessage(error));
            }
            catch (const std::exception& error)
            {
                emitHostError(
                    isInvalidParentWindowFailure(type) ? "INVALID_PARENT_WINDOW" : "HOST_PROTOCOL_ERROR",
                    error.what());
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
