import type { Metadata } from "next";
import { Fraunces, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { DesignProvider } from "@/components/design-provider";
import { ProductTitle } from "@/components/product-title";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "설계형 보험 (종신·암)",
  description: "보험사가 정한 보험금 구조 대신 계약자가 연령별 보험금을 직접 설계하고 보험료·준비금·해약환급금을 즉시 산출",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className={`${fraunces.variable} ${mono.variable}`}>
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css" />
      </head>
      <body className="min-h-screen bg-cream text-ink antialiased">
        <DesignProvider>
          <header className="border-b border-navy/10 bg-white">
            <nav className="mx-auto flex max-w-[1536px] flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3">
              <ProductTitle />
              <Link href="/design" className="text-sm text-navy/70 hover:text-navy">설계</Link>
              <Link href="/builder" className="text-sm text-navy/70 hover:text-navy">상품 만들기</Link>
              <Link href="/compare" className="text-sm text-navy/70 hover:text-navy">비교</Link>
              <Link href="/print" className="text-sm text-navy/70 hover:text-navy">제안서</Link>
              <Link href="/redesign" className="text-sm text-navy/70 hover:text-navy">재설계</Link>
              <Link href="/settings" className="text-sm text-navy/70 hover:text-navy">설정</Link>
              <Link href="/formulas" className="text-sm text-navy/70 hover:text-navy">수식</Link>
            </nav>
          </header>
          <main className="mx-auto max-w-[1536px] px-4 py-6">{children}</main>
        </DesignProvider>
      </body>
    </html>
  );
}
