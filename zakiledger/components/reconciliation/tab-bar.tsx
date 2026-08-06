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
      style={{
        display: "flex",
        gap: 4,
        borderBottom: `1px solid ${shellColor.cardBorder}`,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 600,
              fontFamily: shellFont.body,
              color: isActive ? shellColor.ink : shellColor.inkSoft,
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${isActive ? tab.color : "transparent"}`,
              cursor: "pointer",
              marginBottom: -1,
              transition: "color 120ms, border-color 120ms",
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