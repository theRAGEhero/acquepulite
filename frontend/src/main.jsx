import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
// Bundled from the installed package so the CSS version always matches the JS
// version, and so the map does not depend on a third-party CDN being reachable.
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { installGlobalErrorHandlers } from "./telemetry.js";

installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
