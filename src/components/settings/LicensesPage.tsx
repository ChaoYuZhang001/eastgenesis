import { SettingsSection } from "./controls";

// 许可证（V3 第 8 节「关于 › 许可证」）。版本和许可证取自 2026-10-03 的 node_modules 与 Cargo.lock；
// 应用自身的许可证还没定（第 10 节第 8 条），仓库里也没有 LICENSE 文件，这里如实写「待定」。
const FONTS: [string, string][] = [
  ["Inter", "SIL Open Font License 1.1"],
  ["Montserrat", "SIL Open Font License 1.1"],
  ["JetBrains Mono", "SIL Open Font License 1.1"],
];

const DEPS: [string, string, string][] = [
  ["Tauri", "2.12.0", "Apache-2.0 或 MIT"],
  ["tauri-plugin-sql", "2.5.0", "MIT 或 Apache-2.0"],
  ["React / React DOM", "18.3.1", "MIT"],
  ["Zustand", "5.0.3", "MIT"],
  ["Lucide", "0.469.0", "ISC"],
  ["Radix UI", "见 package.json", "MIT"],
  ["class-variance-authority", "0.7.1", "Apache-2.0"],
  ["clsx", "2.1.1", "MIT"],
  ["tailwind-merge", "2.6.0", "MIT"],
  ["tailwindcss-animate", "1.0.7", "MIT"],
  ["TypeSafe SDK", "0.6.0", "MIT"],
];

export function LicensesPage() {
  return (
    <div className="space-y-10">
      <SettingsSection title="EastGenesis Desktop" description="应用自身的许可证待定。">
        <p className="text-sm text-muted-foreground">在确定之前，本应用不对外分发。</p>
      </SettingsSection>
      <SettingsSection title="打包的字体" description="随应用本地打包，离线可用；苹方、SF、微软雅黑是系统字体，只通过字体栈调用，不打包。">
        <ul aria-label="打包的字体" className="space-y-1 text-sm">
          {FONTS.map(([name, license]) => (
            <li key={name} className="flex gap-3">
              <span className="w-40 shrink-0">{name}</span>
              <span className="text-muted-foreground">{license}</span>
            </li>
          ))}
        </ul>
      </SettingsSection>
      <SettingsSection title="主要依赖">
        <table className="w-full max-w-xl text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-normal">
                名称
              </th>
              <th scope="col" className="py-1 font-normal">
                版本
              </th>
              <th scope="col" className="py-1 font-normal">
                许可证
              </th>
            </tr>
          </thead>
          <tbody>
            {DEPS.map(([name, version, license]) => (
              <tr key={name} className="border-t border-border">
                <td className="py-2">{name}</td>
                <td className="py-2 tabular-nums text-muted-foreground">{version}</td>
                <td className="py-2">{license}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsSection>
    </div>
  );
}
