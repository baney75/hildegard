/** Hildegard bundle: window.Hildegard. Components are CSS classes in bundle.css; this object adds icons and adaptive layout. */
export type WindowClass = 'compact' | 'medium' | 'expanded' | 'wide';
export type LayoutMode = 'auto' | 'desktop' | 'tablet' | 'phone';
export interface IconProps { name: keyof typeof Hildegard.icons; size?: number; label?: string }
export interface AppShellProps { mode?: LayoutMode }
export interface LayoutSwitchProps { mode: LayoutMode; persist?: boolean; app?: HTMLElement }
declare const Hildegard: {
  /** Path data for every interface icon, 24px grid. */
  icons: Record<string, string>;
  /** SVG markup for one icon in currentColor. A label makes it role="img". */
  icon(name: string, size?: number, label?: string): string;
  /** Replace <i data-icon> placeholders under root. */
  hydrate(root?: ParentNode): void;
  /** Breakpoints in px, mirroring tokens bp-medium, bp-expanded, bp-wide. */
  breakpoints: { medium: 600; expanded: 840; wide: 1280 };
  windowClass(width: number): WindowClass;
  /** Force or release a layout. Persists to localStorage key hildegard.layout unless persist is false. */
  setLayout(mode: LayoutMode, opts?: { persist?: boolean; app?: HTMLElement }): void;
  /** Start adapting an .hg-app to the space around it; sets data-wc and data-forced. */
  watch(app: HTMLElement, opts?: AppShellProps): void;
};
