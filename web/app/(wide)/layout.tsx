import { AppShell } from "@/components/AppShell";

export default function WideLayout({ children }: LayoutProps<"/">) {
  return <AppShell wide>{children}</AppShell>;
}
