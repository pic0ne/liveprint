# Vendored Typst packages

The compiler resolves `@preview/<name>:<version>` imports from these tarballs in memory, so nothing is fetched at runtime. Each file is the unmodified archive from `https://packages.typst.org/preview/<name>-<version>.tar.gz`.

| File | Package | Licence | SHA-256 |
|---|---|---|---|
| `public/packages/mitex-0.2.6.tar.gz` | [mitex](https://github.com/mitex-rs/mitex) 0.2.6, LaTeX math for Typst | Apache-2.0 | `e45b8341f774e11036a9092b9217a95b7656d11acea9c4d24dc028e4dc849838` |
| `bench/packages/cmarker-0.1.8.tar.gz` | [cmarker](https://github.com/SabrinaJewson/cmarker.typ) 0.1.8, used only by `npm run bench` | MIT | `157cc40db2716f12c7eabb95df1f60714a4d95ebfb1c6087cf4aec224e49392a` |
