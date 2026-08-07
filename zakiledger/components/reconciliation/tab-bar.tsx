"use client";

import { shellColor, pill, shellFont } from "@/lib/shell-theme";

export interface TabItem {
  key: string;
  label: string;
  count: number;
  color: string;
  bgColor: string;
}

interface TabBarProps {
  tabs: TabItem[];
  activeTab: string;
  onTabChange: (key: string) => void;
}

export default function TabBar({ tabs, activeTab, onTabChange }: TabBarProps) {
  return (
    <div
      className="zl-flex zl-gap-8 zl-border-b"
      style={{ borderBottom: `1px solid ${shellColor.cardBorder}` }}
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className="zl-inline-flex zl-items-center zl-gap-8 zl-px-4 zl-py-3 zl-text-sm zl-font-semibold zl-bg-transparent zl-border-none zl-pointer zl-transition-colors"
            style={{
              fontFamily: shellFont.body,
              color: isActive ? shellColor.ink : shellColor.inkSoft,
              borderBottom: `2px solid ${isActive ? tab.color : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {tab.label}
            <span style={pill(tab.color, isActive ? tab.bgColor : shellColor.trackBg, "sm")}>
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}