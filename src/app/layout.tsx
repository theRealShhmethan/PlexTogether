import type { Metadata } from "next";
import { TopBar } from "@/components/TopBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlexTogether",
  description: "Watch media from your Plex Media Server together, in sync.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browser extensions (password managers etc.) add attributes to <html>/<body>
    // before React loads; don't treat those as errors. Only affects these two tags.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <TopBar />
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
