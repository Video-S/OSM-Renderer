import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.warn('Caught WebGL/Three.js error in ErrorBoundary:', error, errorInfo);
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  public reset = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center text-slate-200">
          <h2 className="text-lg font-semibold text-amber-400">Rendering Error</h2>
          <p className="text-sm text-slate-400 mt-2">{this.state.error.message}</p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-4 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg text-sm border border-slate-600"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
