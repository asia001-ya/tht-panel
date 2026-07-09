import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";
import "./styles/app.css";
import "@xterm/xterm/css/xterm.css";

// 注意：不使用 React.StrictMode。xterm 是命令式库，StrictMode 在开发模式下
// 双调用 effect 会导致终端实例被创建两次 / attach 两次，产生难排查的问题。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
