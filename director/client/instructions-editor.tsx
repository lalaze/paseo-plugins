import { View } from "react-native";
import { Button, ErrorText, Field, Label, type Theme } from "./ui";
import { ui } from "./i18n";

export function InstructionsEditor({ label, description, value, onChange, example, theme }: { label: string; description: string; value: string; onChange: (value: string) => void; example?: string; theme: Theme }) {
  return <View style={{ gap: 8 }}>
    <Field theme={theme} label={ui(`${label} (optional)`, `${label}（可选）`)} multiline value={value} onChange={onChange} placeholder={example ?? ui("Example: Keep frontend changes consistent with the existing component library, including keyboard use and narrow layouts.", "例如：前端修改沿用现有组件库，关注键盘操作和窄屏布局。")} />
    <Label theme={theme} muted>{description}{ui("Leave blank to omit these instructions.", "留空不追加这部分要求。")}</Label>
    <Label theme={theme} muted>{ui(`${value.length} / 8000 characters`, `${value.length} / 8000 个字符`)}</Label>
    <ErrorText theme={theme} error={value.length > 8000 ? ui(`${label} is limited to 8000 characters. Shorten it before saving.`, `${label}最多 8000 个字符，请缩短后保存。`) : null} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {example && <Button theme={theme} secondary label={ui("Use example instructions", "填入参考提示词")} disabled={!!value.trim()} onPress={() => onChange(example)} />}
      {!!value && <Button theme={theme} secondary label={ui(`Clear ${label}`, `清空${label}`)} onPress={() => onChange("")} />}
    </View>
  </View>;
}
