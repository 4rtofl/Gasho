import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startPush } from "./lib/push";
import { start } from "./lib/store";
import "./plugins/theme";
import "./index.css";

void start();
startPush();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
