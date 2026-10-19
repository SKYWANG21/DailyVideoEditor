module.exports = {
  printWidth: 140, // 单行长度
  wrapAttributes: true, // html标签属性换行(超过单长长度时才换行)
  jsxBracketSameLine: false, // 在jsx中把'>' 是否单独放一行，多属性html标签的‘>’折行放置
  tabWidth: 2, // 缩进长度
  useTabs: false, // 使用空格代替tab缩进
  semi: true, // 句末使用分号
  singleQuote: false, // 使用单引号
  jsxSingleQuote: true, // jsx中使用单引号
  trailingComma: "all", // 多行时尽可能打印尾随逗号
  insertPragma: false, // 在已被prettier格式化的文件顶部加上标注
  proseWrap: "preserve",
  endOfLine: "lf", // 保持各平台换行符统一为lf

  embeddedLanguageFormatting: "auto", // 对引用代码进行格式化
  bracketSpacing: true, // 在对象前后添加空格-eg: { foo: bar }
  arrowParens: "always", // 单参数箭头函数参数周围使用圆括号-eg: (x) => x
  requirePragma: false, // 无需顶部注释即可格式化
  htmlWhitespaceSensitivity: "ignore", // 对HTML全局空白不敏感
  vueIndentScriptAndStyle: false, // 不对vue中的script及style标签缩进
};
