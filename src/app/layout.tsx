import type { Metadata } from "next";
import { TopBar } from "@/components/TopBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlexTogether",
  description: "Watch media from your Plex Media Server together, in sync.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <TopBar />
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
