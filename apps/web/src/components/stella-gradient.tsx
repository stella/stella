import { cn } from "@stella/ui/lib/utils";

type StellaGradientProps = {
  className?: string;
  children?: React.ReactNode;
};

const GRADIENT_STYLE = `
@keyframes stella-drift {
  0%, 100% {
    background-position: 0% 50%;
  }
  25% {
    background-position: 100% 25%;
  }
  50% {
    background-position: 50% 100%;
  }
  75% {
    background-position: 25% 0%;
  }
}

.stella-gradient {
  background: radial-gradient(
      ellipse 80% 60% at 20% 40%,
      rgba(89, 161, 212, 0.25) 0%,
      transparent 70%
    ),
    radial-gradient(
      ellipse 60% 80% at 80% 30%,
      rgba(188, 209, 243, 0.35) 0%,
      transparent 70%
    ),
    radial-gradient(
      ellipse 70% 50% at 50% 80%,
      rgba(227, 246, 254, 0.4) 0%,
      transparent 70%
    ),
    #ffffff;
  background-size: 200% 200%;
  animation: stella-drift 20s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .stella-gradient {
    animation: none;
    background-size: 100% 100%;
  }
}
`;

/**
 * Animated brand gradient background. Uses the Stella brand
 * colours (#59a1d4, #bcd1f3, #e3f6fe) with a slow, subtle
 * drift animation.
 */
export const StellaGradient = ({
  className,
  children,
}: StellaGradientProps) => (
  <div className={cn("relative overflow-hidden", className)}>
    <style>{GRADIENT_STYLE}</style>
    <div aria-hidden="true" className="stella-gradient absolute inset-0" />
    {children !== undefined && <div className="relative z-10">{children}</div>}
  </div>
);
