import type { Metadata } from "next";

import { AuthProvider } from "@/components/auth-provider";
import { DeviceAccessGuard } from "@/components/device-access-guard";

import "./globals.css";

export const metadata: Metadata = {
  title: "outcomes.ai speech annotator",
  description: "Production-grade annotation workspace for transcript and metadata correction"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <DeviceAccessGuard>{children}</DeviceAccessGuard>
        </AuthProvider>
      </body>
    </html>
  );
}
