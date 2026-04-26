/**
 * Error Boundary Component
 *
 * Catches render errors and displays fallback UI.
 * Also provides error toast/notification system.
 */

import React, {
  Component,
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ReactNode, ErrorInfo } from "react";

import {
  AlertCircleIcon,
  AlertTriangleIcon,
  FileWarningIcon,
  InfoIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import { ErrorManager } from "../core/core";
import type { ErrorSeverity, ErrorNotification } from "../core/core";
import { cn } from "../lib/utils";

// Re-export for backwards compat
export type { ErrorSeverity, ErrorNotification };

/**
 * Error context value
 */
export type ErrorContextValue = {
  /** Current notifications */
  notifications: ErrorNotification[];
  /** Show an error notification */
  showError: (message: string, details?: string) => void;
  /** Show a warning notification */
  showWarning: (message: string, details?: string) => void;
  /** Show an info notification */
  showInfo: (message: string, details?: string) => void;
  /** Dismiss a notification */
  dismissNotification: (id: string) => void;
  /** Clear all notifications */
  clearNotifications: () => void;
};

/**
 * Error boundary props
 */
export type ErrorBoundaryProps = {
  /** Child components to render */
  children: ReactNode;
  /** Custom fallback UI */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Callback when error occurs */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Whether to show error details */
  showDetails?: boolean;
};

/**
 * Error boundary state
 */
type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
};

// ============================================================================
// CONTEXT
// ============================================================================

const ErrorContext = createContext<ErrorContextValue | null>(null);

/**
 * Hook to use error notifications
 */
export function useErrorNotifications(): ErrorContextValue {
  const context = useContext(ErrorContext);
  if (!context) {
    throw new Error(
      "useErrorNotifications must be used within an ErrorProvider",
    );
  }
  return context;
}

// ============================================================================
// ERROR PROVIDER
// ============================================================================

/**
 * Error notification provider
 *
 * Thin React wrapper around the framework-agnostic ErrorManager.
 * Uses useSyncExternalStore to subscribe to ErrorManager state.
 */
export function ErrorProvider({ children }: { children: ReactNode }) {
  // Create ErrorManager once
  const manager = useMemo(() => new ErrorManager(), []);

  // Subscribe to manager state
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot);

  const showError = useCallback(
    (message: string, details?: string) => {
      manager.showError(message, details);
    },
    [manager],
  );

  const showWarning = useCallback(
    (message: string, details?: string) => {
      manager.showWarning(message, details);
    },
    [manager],
  );

  const showInfo = useCallback(
    (message: string, details?: string) => {
      manager.showInfo(message, details);
    },
    [manager],
  );

  const dismissNotification = useCallback(
    (id: string) => {
      manager.dismiss(id);
    },
    [manager],
  );

  const clearNotifications = useCallback(() => {
    manager.clearAll();
  }, [manager]);

  const value: ErrorContextValue = useMemo(
    () => ({
      notifications: snapshot.notifications,
      showError,
      showWarning,
      showInfo,
      dismissNotification,
      clearNotifications,
    }),
    [
      snapshot.notifications,
      showError,
      showWarning,
      showInfo,
      dismissNotification,
      clearNotifications,
    ],
  );

  return (
    <ErrorContext.Provider value={value}>
      {children}
      <NotificationContainer
        notifications={snapshot.notifications}
        onDismiss={dismissNotification}
      />
    </ErrorContext.Provider>
  );
}

// ============================================================================
// NOTIFICATION CONTAINER
// ============================================================================

type NotificationContainerProps = {
  notifications: ErrorNotification[];
  onDismiss: (id: string) => void;
};

function NotificationContainer({
  notifications,
  onDismiss,
}: NotificationContainerProps) {
  const visibleNotifications = notifications.filter((n) => !n.dismissed);

  if (visibleNotifications.length === 0) {
    return null;
  }

  return (
    <div className="fixed end-4 top-4 z-[10001] flex max-w-[400px] flex-col gap-2">
      {visibleNotifications.map((notification) => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          onDismiss={() => onDismiss(notification.id)}
        />
      ))}
    </div>
  );
}

// ============================================================================
// NOTIFICATION TOAST
// ============================================================================

const SEVERITY_STYLES = {
  error:
    "border-destructive/30 bg-destructive/10 text-destructive [&_svg]:text-destructive",
  warning:
    "border-yellow-500/30 bg-yellow-50 text-yellow-800 [&_svg]:text-yellow-600",
  info: "border-blue-500/30 bg-blue-50 text-blue-800 [&_svg]:text-blue-600",
} as const;

const SEVERITY_ICONS = {
  error: AlertCircleIcon,
  warning: AlertTriangleIcon,
  info: InfoIcon,
} as const;

type NotificationToastProps = {
  notification: ErrorNotification;
  onDismiss: () => void;
};

function NotificationToast({
  notification,
  onDismiss,
}: NotificationToastProps) {
  const t = useTranslations("folio");
  const [isExpanded, setIsExpanded] = useState(false);
  const SeverityIcon = SEVERITY_ICONS[notification.severity];

  return (
    <div
      className={cn(
        "animate-in slide-in-from-right rounded-lg border p-3 shadow-md",
        SEVERITY_STYLES[notification.severity],
      )}
    >
      <div className="flex items-start gap-2">
        <SeverityIcon className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">
            {notification.message}
          </p>
          {notification.details && (
            <>
              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="mt-1 cursor-pointer rounded px-2 py-0.5 text-xs opacity-80 hover:opacity-100"
              >
                {isExpanded ? t("hideDetails") : t("showDetails")}
              </button>
              {isExpanded && (
                <pre className="mt-2 max-h-[200px] overflow-auto rounded bg-black/5 p-2 font-mono text-xs break-words whitespace-pre-wrap">
                  {notification.details}
                </pre>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 cursor-pointer rounded p-1 opacity-60 hover:opacity-100"
          title={t("dismiss")}
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// ERROR BOUNDARY
// ============================================================================

/**
 * Error Boundary class component
 *
 * Catches render errors in child components and displays fallback UI.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // oxlint-disable-next-line react/no-set-state
    this.setState({ errorInfo });

    // Log error
    console.error("ErrorBoundary caught an error:", error, errorInfo);

    // Call callback
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  resetError = (): void => {
    // oxlint-disable-next-line react/no-set-state
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      const { fallback, showDetails = true } = this.props;
      const { error, errorInfo } = this.state;

      // Custom fallback
      if (fallback) {
        if (typeof fallback === "function") {
          // oxlint-disable-next-line typescript/no-non-null-assertion
          return fallback(error!, this.resetError);
        }
        return fallback;
      }

      // Default fallback UI
      return (
        <DefaultErrorFallback
          // oxlint-disable-next-line typescript/no-non-null-assertion
          error={error!}
          errorInfo={errorInfo}
          showDetails={showDetails}
          onReset={this.resetError}
        />
      );
    }

    return this.props.children;
  }
}

// ============================================================================
// DEFAULT ERROR FALLBACK
// ============================================================================

type DefaultErrorFallbackProps = {
  error: Error;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
  onReset: () => void;
};

function DefaultErrorFallback({
  error,
  errorInfo,
  showDetails,
  onReset,
}: DefaultErrorFallbackProps): React.ReactElement {
  const t = useTranslations("folio");

  return (
    <div className="bg-background m-5 flex min-h-[200px] flex-col items-center justify-center rounded-lg border p-10 text-center">
      <AlertCircleIcon className="text-destructive mb-4 size-12" />
      <h2 className="text-foreground mb-2 text-lg font-semibold">
        {t("somethingWentWrong")}
      </h2>
      <p className="text-muted-foreground mb-4 max-w-[400px] text-sm">
        An error occurred while rendering this component. Please try again or
        contact support if the problem persists.
      </p>
      {showDetails && (
        <pre className="bg-destructive/10 mb-4 max-h-[200px] w-full max-w-[600px] overflow-auto rounded p-3 text-start font-mono text-xs break-words whitespace-pre-wrap">
          <strong>Error:</strong> {error.message}
          {errorInfo && (
            <>
              {"\n\n"}
              <strong>Component Stack:</strong>
              {errorInfo.componentStack}
            </>
          )}
        </pre>
      )}
      <Button variant="default" onClick={onReset}>
        {t("tryAgain")}
      </Button>
    </div>
  );
}

// ============================================================================
// PARSE ERROR DISPLAY
// ============================================================================

export type ParseErrorDisplayProps = {
  message: string;
  details?: string;
  onRetry?: () => void;
  className?: string;
};

/**
 * Parse error display component
 *
 * Shows a helpful message for DOCX parsing errors.
 */
export function ParseErrorDisplay({
  message,
  details,
  onRetry,
  className = "",
}: ParseErrorDisplayProps): React.ReactElement {
  return (
    <div
      className={cn(
        "bg-background flex flex-col items-center justify-center rounded-lg border p-10 text-center",
        className,
      )}
    >
      <FileWarningIcon className="text-destructive mb-4 size-10" />
      <h3 className="text-foreground mb-2 text-base font-semibold">
        Unable to Parse Document
      </h3>
      <p className="text-muted-foreground mb-4 max-w-[400px] text-sm">
        {message}
      </p>
      {details && (
        <pre className="bg-muted mb-4 max-w-full overflow-auto rounded p-3 text-start font-mono text-xs">
          {details}
        </pre>
      )}
      {onRetry && (
        <Button variant="default" size="sm" onClick={onRetry}>
          Try Again
        </Button>
      )}
    </div>
  );
}

// ============================================================================
// UNSUPPORTED FEATURE WARNING
// ============================================================================

export type UnsupportedFeatureWarningProps = {
  feature: string;
  description?: string;
  className?: string;
};

/**
 * Unsupported feature warning component
 *
 * Shows a non-blocking warning for unsupported features.
 */
export function UnsupportedFeatureWarning({
  feature,
  description,
  className = "",
}: UnsupportedFeatureWarningProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded border border-yellow-500/30 bg-yellow-50 px-3 py-2 text-xs text-yellow-800",
        className,
      )}
    >
      <AlertTriangleIcon className="size-4 shrink-0 text-yellow-600" />
      <span>
        <strong>{feature}</strong>
        {description && `: ${description}`}
      </span>
    </div>
  );
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if an error is a parse error
 */
export function isParseError(error: Error): boolean {
  return (
    error.message.includes("parse") ||
    error.message.includes("Parse") ||
    error.message.includes("XML") ||
    error.message.includes("DOCX") ||
    error.message.includes("Invalid")
  );
}

/**
 * Get user-friendly error message
 */
export function getUserFriendlyMessage(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes("network") || message.includes("fetch")) {
    return "Network error. Please check your internet connection and try again.";
  }

  if (
    message.includes("parse") ||
    message.includes("xml") ||
    message.includes("invalid")
  ) {
    return "The document could not be parsed. It may be corrupted or in an unsupported format.";
  }

  if (message.includes("permission") || message.includes("access")) {
    return "Access denied. You may not have permission to access this file.";
  }

  if (message.includes("not found") || message.includes("404")) {
    return "The requested file was not found.";
  }

  if (message.includes("timeout")) {
    return "The operation timed out. Please try again.";
  }

  return "An unexpected error occurred. Please try again.";
}

// ============================================================================
// EXPORTS
// ============================================================================
