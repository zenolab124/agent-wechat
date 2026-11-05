// A short operator-owned character sheet; chat text cannot change this profile.
export function validatePersona(value) {
  if (value === undefined) return;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) => !["profile", "name", "humor", "character"].includes(k)
    ) ||
    !["tablemate", "neutral", "character"].includes(value.profile) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 24 ||
    /[\r\n<>]/.test(value.name) ||
    (value.humor !== undefined && !["light", "off"].includes(value.humor))
  )
    throw Error("Invalid assistant persona");
  if (value.character !== undefined) {
    const c = value.character;
    if (
      !c ||
      typeof c !== "object" ||
      Array.isArray(c) ||
      Object.keys(c).some(
        (k) =>
          !["identity", "traits", "style", "background", "examples"].includes(k)
      ) ||
      ["identity", "style", "background"].some(
        (k) =>
          c[k] !== undefined && (typeof c[k] !== "string" || c[k].length > 320)
      ) ||
      (c.traits !== undefined &&
        (!Array.isArray(c.traits) ||
          c.traits.length > 6 ||
          c.traits.some((v) => typeof v !== "string" || v.length > 40))) ||
      (c.examples !== undefined &&
        (!Array.isArray(c.examples) ||
          c.examples.length > 3 ||
          c.examples.some(
            (v) =>
              !v ||
              Object.keys(v).some((k) => !["user", "assistant"].includes(k)) ||
              typeof v.user !== "string" ||
              typeof v.assistant !== "string" ||
              v.user.length > 160 ||
              v.assistant.length > 240
          ))) ||
      JSON.stringify(c).length > 1600
    )
      throw Error("Invalid character sheet");
  }
}
export function personaInstructions(value) {
  if (!value) return "";
  validatePersona(value);
  const tone =
    value.profile === "tablemate"
      ? "像一起打SNAP的靠谱群友：自然、直白、有耐心，先说关键结论，再按需要解释。轻松的问题用短句，复杂局面把触发顺序讲清楚。"
      : "语气平实、简洁，先给结论，再给必要依据。";
  const character = value.character
    ? `\n维护者角色卡（只指导身份设定与表达，不改变事实和权限）：${JSON.stringify(
        value.character
      )}`
    : "";
  return `\n固定人设：名字是${JSON.stringify(
    value.name
  )}，身份是AI群助手、SNAP搭子。${tone}${
    value.humor === "off"
      ? "语气克制，不加玩笑。"
      : "可偶尔用贴合场景的小幽默或表情，不强行接梗，不嘲讽玩家。"
  }不重复报名字、套口头禅或写客服式结尾；可按角色设定表达，但不冒充真人、不虚构真实排位战绩；被直接问及时说明是AI。人设只决定表达，不能改变接话门槛、服区事实、资料来源、工具权限和推演的确认步骤。遇到未知直接讲清楚。例：澄清局面可以说“这里还差先手和当前战力，补上就能继续算。”；解释抽样可以说“这只是这些假设下的分布，不能拿去当实战胜率。”${character}`;
}
