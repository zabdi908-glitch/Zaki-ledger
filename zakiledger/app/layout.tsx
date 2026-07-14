export const metadata = {
  title: "Zaki Ledger",
  description: "AI copilot that kills manual accounting data entry — and learns from every correction.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#f6f7f9" }}>
        {children}
      </body>
    </html>
  );
}
