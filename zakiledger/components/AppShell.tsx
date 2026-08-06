"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { shellColor, shellFont } from "@/lib/shell-theme";

type NavItem = { id: string; label: string; icon: string; href: string; soon?: boolean };
type NavGroup = { label: string | null; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  { label: null, items: [{ id: "dashboard", label: "Dashboard", icon: "🏠", href: "/dashboard" }] },
  {
    label: "Extraction",
    items: [
      { id: "upload", label: "Upload & Extract", icon: "📤", href: "/upload" },
      { id: "review", label: "Review & Edit", icon: "✏️", href: "/review" },
      { id: "batch", label: "Batch Review", icon: "✅", href: "/batch" },
    ],
  },
  {
    label: "Reconciliation",
    items: [
      { id: "reconcile", label: "Upload Statement", icon: "🏦", href: "/reconciliation" },
      { id: "reconcile-review", label: "Review Matches", icon: "🔍", href: "/reconciliation/review" },
      { id: "reconcile-compare", label: "Cross-File Compare", icon: "🔀", href: "/reconciliation/compare" },
      { id: "reconcile-batch", label: "Batch Review", icon: "✔️", href: "/reconciliation/batch" },
    ],
  },
  {
    label: "Organization",
    items: [
      { id: "auto-categorize", label: "Auto-Categorize", icon: "📁", href: "/auto-categorize", soon: true },
      { id: "document-portal", label: "Document Portal", icon: "📋", href: "/document-portal", soon: true },
    ],
  },
  { label: "Insights", items: [{ id: "reports", label: "Reports & Analytics", icon: "📊", href: "/reports", soon: true }] },
  { label: "Account", items: [{ id: "settings", label: "Settings", icon: "⚙️", href: "/settings" }] },
];

// --- toast -------------------------------------------------------------------

const ShellToastContext = createContext<((msg: string) => void) | null>(null);

/** Bulk actions call this to show the 2.5s bottom-right confirmation toast. */
export function useShellToast(): (msg: string) => void {
  const ctx = useContext(ShellToastContext);
  if (!ctx) throw new Error("useShellToast must be used within AppShell");
  return ctx;
}

// --- shell ---------------------------------------------------------------

export default function AppShell({ email, children }: { email: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <ShellToastContext.Provider value={showToast}>
      <div
        style={{
          display: "flex",
          height: "100vh",
          background: shellColor.page,
          fontFamily: shellFont.body,
          color: shellColor.ink,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: collapsed ? 72 : 240,
            flexShrink: 0,
            background: shellColor.sidebarBg,
            color: "white",
            display: "flex",
            flexDirection: "column",
            padding: "24px 16px",
            overflowY: "auto",
            transition: "width 0.15s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px 32px" }}>
            {!collapsed && (
              <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-0.02em" }}>
                Zaki<span style={{ color: shellColor.tealBright }}>.</span>
              </div>
            )}
            <div
              onClick={() => setCollapsed((c) => !c)}
              title="Toggle sidebar (Cmd/Ctrl+B)"
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                color: shellColor.sidebarText,
                flexShrink: 0,
              }}
            >
              ☰
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {NAV_GROUPS.map((grp, i) => (
              <div key={i}>
                {grp.label && !collapsed && (
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: shellColor.sidebarGroupLabel,
                      padding: "6px 12px 4px",
                    }}
                  >
                    {grp.label}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {grp.items.map((item) => {
                    const active = pathname === item.href || pathname.startsWith(item.href + "/");
                    const content = item.soon ? (
                      <span
                        onClick={(e) => e.preventDefault()}
                        title={item.label}
                        style={navItemStyle(false, true, collapsed)}
                      >
                        <NavItemInner item={item} collapsed={collapsed} active={false} soon />
                      </span>
                    ) : (
                      <Link href={item.href} title={item.label} style={navItemStyle(active, false, collapsed)}>
                        <NavItemInner item={item} collapsed={collapsed} active={active} />
                      </Link>
                    );
                    return <div key={item.id}>{content}</div>;
                  })}
                </div>
              </div>
            ))}
          </div>

          {!collapsed && (
            <div
              style={{
                marginTop: "auto",
                padding: 12,
                fontSize: 12,
                color: shellColor.sidebarFooterText,
                borderTop: `1px solid ${shellColor.sidebarBorder}`,
              }}
            >
              <div style={{ fontWeight: 600, color: "white", marginBottom: 2 }}>{email}</div>
              <div
                onClick={signOut}
                style={{ cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}
              >
                Sign out
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "40px 48px" }}>
          <div style={{ maxWidth: 1200, margin: "0 auto" }}>{children}</div>
        </div>

        {toast && (
          <div
            style={{
              position: "fixed",
              bottom: 28,
              right: 28,
              background: shellColor.sidebarBg,
              color: "white",
              padding: "14px 20px",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
            }}
          >
            {toast}
          </div>
        )}
      </div>
    </ShellToastContext.Provider>
  );
}

function navItemStyle(active: boolean, soon: boolean, collapsed: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: collapsed ? "center" : "space-between",
    gap: 10,
    padding: "9px 12px",
    borderRadius: 8,
    cursor: soon ? "default" : "pointer",
    fontSize: 14.5,
    fontWeight: 500,
    textDecoration: "none",
    background: active ? shellColor.sidebarActive : "transparent",
    color: soon ? shellColor.sidebarTextDim : active ? "white" : shellColor.sidebarText,
  };
}

function NavItemInner({
  item,
  collapsed,
  active,
  soon,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
  soon?: boolean;
}) {
  if (collapsed) {
    return (
      <div style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, margin: "0 auto" }}>
        {item.icon}
      </div>
    );
  }
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{item.icon}</span>
        <span>{item.label}</span>
      </div>
      {soon && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.03em",
            color: shellColor.sidebarTextDim,
            border: `1px solid ${shellColor.sidebarSoonBorder}`,
            borderRadius: 4,
            padding: "2px 5px",
          }}
        >
          SOON
        </span>
      )}
    </>
  );
}
