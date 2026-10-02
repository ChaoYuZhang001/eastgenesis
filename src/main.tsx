import React from "react";
import ReactDOM from "react-dom/client";
// 字体本地打包（SIL OFL 1.1），不走在线 CDN（BRAND.md 第 5 节）
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles/globals.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
