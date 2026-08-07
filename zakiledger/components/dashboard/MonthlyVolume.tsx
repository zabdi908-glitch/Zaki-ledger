"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { shellColor, shellFont, shellCard } from "@/lib/shell-theme";

interface MonthlyVolumeProps {
  data: { label: string; value: number }[];
}

export default function MonthlyVolume({ data }: MonthlyVolumeProps) {
  const currentIndex = data.length - 1;

  return (
    <div style={shellCard({ padding: 24 })}>
      <div
        style={{
          fontFamily: shellFont.body,
          fontSize: 15,
          fontWeight: 600,
          color: shellColor.ink,
          marginBottom: 16,
        }}
      >
        Monthly extraction volume
      </div>

      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barCategoryGap="20%">
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{
              fill: shellColor.inkFaint,
              fontSize: 12,
              fontFamily: shellFont.body,
            }}
          />
          <YAxis hide />
          <Tooltip
            cursor={{ fill: "transparent" }}
            contentStyle={{
              background: shellColor.paper,
              border: `1px solid ${shellColor.cardBorder}`,
              borderRadius: 10,
              fontSize: 13,
              fontFamily: shellFont.body,
              color: shellColor.ink,
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            }}
          />
          <Bar dataKey="value" radius={[6, 6, 0, 0]}>
            {data.map((_, index) => (
              <Cell
                key={`cell-${index}`}
                fill={index === currentIndex ? shellColor.teal : "#cbd5e1"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}