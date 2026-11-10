import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./style.css";

const telegram = window.Telegram?.WebApp;

if (telegram) {
  telegram.ready();
  telegram.expand();
  telegram.setHeaderColor("#090d16");
  telegram.setBackgroundColor("#090d16");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
