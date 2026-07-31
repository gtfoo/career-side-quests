import type { Metadata } from "next";
import { PRODUCT } from "@/config/product";
import "./globals.css";

// Reads from src/config/product.ts so renaming stays a one-file edit.
export const metadata: Metadata = {
  title: PRODUCT.name,
  description: PRODUCT.tagline,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
