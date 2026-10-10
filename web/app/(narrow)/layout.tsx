import { AppShell } from "@/components/AppShell";

export default function NarrowLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
