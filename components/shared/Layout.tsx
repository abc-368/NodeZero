import React from 'react';
import { cn } from '@/lib/utils';

interface LayoutProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Main popup container — 380px fixed width.
 *
 * In the extension popup: Chrome auto-sizes the frame to content (up to ~600px).
 * In a pop-out window: fills the viewport via min-h-screen so the user can
 * resize freely without double scrollbars.
 *
 * ScrollableBody provides the single scroll region for long content.
 */
/** Detect side panel mode via the CSS class set by sidepanel/main.tsx */
function isSidePanelMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('sidepanel-mode');
}

export function Layout({ children, className }: LayoutProps) {
  const sidepanel = isSidePanelMode();
  return (
    <div
      className={cn(
        'flex flex-col bg-background text-foreground',
        sidepanel
          ? 'w-full h-screen'
          : 'w-[380px] min-h-[500px] max-h-screen',
        className
      )}
    >
      {children}
    </div>
  );
}

interface HeaderProps {
  title: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
}

export function Header({ title, left, right }: HeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card shrink-0">
      <div className="w-8">{left}</div>
      <h1 className="text-sm font-semibold text-foreground">{title}</h1>
      <div className="w-8 flex justify-end">{right}</div>
    </div>
  );
}

interface ScrollableBodyProps {
  children: React.ReactNode;
  className?: string;
}

export function ScrollableBody({ children, className }: ScrollableBodyProps) {
  return (
    <div className={cn('flex-1 overflow-y-auto', className)}>
      {children}
    </div>
  );
}

interface FooterProps {
  children: React.ReactNode;
}

export function Footer({ children }: FooterProps) {
  return (
    <div className="shrink-0 px-4 py-3 border-t border-border bg-card">
      {children}
    </div>
  );
}
