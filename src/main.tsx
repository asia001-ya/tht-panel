import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/theme.css";
import "./styles/base.css";
import "./styles/sidebar.css";
import "./styles/main.css";
import "./styles/dialogs.css";
import "./styles/views.css";
import "@xterm/xterm/css/xterm.css";

// 注意：不使用 React.StrictMode。xterm 是命令式库，StrictMode 在开发模式下
// 双调用 effect 会导致终端实例被创建两次 / attach 两次，产生难排查的问题。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

// 字体加载完成后触发终端 refit，确保 WebGL 字形图集正确
document.fonts.ready.then(() => {
  window.dispatchEvent(new CustomEvent("app:refit"));
});
