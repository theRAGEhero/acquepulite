import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("Map error boundary:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          height: "100%", width: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "#0e1726", color: "#e6edf3", flexDirection: "column",
          padding: 20, textAlign: "center", gap: 12
        }}>
          <div style={{ fontSize: 28 }}>⚠️</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Map failed to load</div>
          <div style={{ fontSize: 12, color: "#9ca3af", maxWidth: 320 }}>
            {this.state.error?.message || "Unknown error"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: 8, padding: "8px 16px", background: "#2563eb",
              border: "none", borderRadius: 6, color: "#fff", cursor: "pointer"
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}