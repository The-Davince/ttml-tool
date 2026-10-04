<div align=center>

<img src="./public/logo.svg" align="center" width="256">

# TTML Tool

一个更好用的 <del>（可能是）</del> 逐词歌词编辑器！基于 [amll-ttml-tool](https://github.com/amll-dev/amll-ttml-tool ) 二改。

<img width="1312" alt="image" src="https://zhishi.oss-cn-beijing.aliyuncs.com/user_projects_assets/cd2de06ba8c14173a28700fcd1318c5e.bmp?x-oss-process=image/rounded-corners,r_25/format,png">

<img width="1312" alt="image" src="https://zhishi.oss-cn-beijing.aliyuncs.com/user_projects_assets/6ea760b1cadd4456be2bafb6ffbcacd6.bmp?x-oss-process=image/rounded-corners,r_25/format,png">

<img width="1312" alt="image" src="https://zhishi.oss-cn-beijing.aliyuncs.com/user_projects_assets/7998417a3f854687aefc6f59c6cb66c1.bmp?x-oss-process=image/rounded-corners,r_25/format,png">

</div>

## 使用

> [!WARNING]
> 本工具不建议移动手机或小尺寸电子设备使用，操作会非常繁琐！

你可以通过访问 [`https://ttml.223110.xyz/`](https://ttml.223110.xyz/)来使用本工具的在线版本。



## 编辑器功能

- 基本输入、编辑、打轴功能
- 读取保存 TTML 格式歌词
- 配置歌词行行为（背景歌词、对唱歌词等）
- 配置歌词文件元数据（名称，作者，网易云音乐 ID 等）
- 拆分/组合/移动单词
- LRC/ESLyric/YRC/QRC/Lyricify Syllable 等歌词文件格式的导入以及部分格式的导出
- 支持带有特殊标识符的纯文本导入歌词
- 可配置的快捷键

## 开发构建


首先，本项目仅可使用 PNPM，请确保你已经安装好了 PNPM 包管理器！

然后克隆本仓库，然后在仓库文件夹下执行构建：

```bash
pnpm i # 安装依赖
pnpm dev # 开启开发服务器
pnpm build # 构建网页版本
pnpm tauri dev # 开启 Tauri 桌面版本开发环境
pnpm tauri build # 构建 Tauri 桌面版本
```

## 贡献

欢迎各种积极的代码/翻译贡献！也欢迎积极提交各种议题和建议！

如果想要提供新的语言翻译，可以参考 [`./src/i18n/index.ts`](./src/i18n/index.ts) 和 [`./locales/zh-CN/translation.json`](./locales/zh-CN/translation.json) 哦！
