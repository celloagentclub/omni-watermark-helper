# Cloudflare 授权服务

此目录包含 Omni 去水印助手可选的一机一码授权服务，使用 Cloudflare Workers
和 D1。客户端仅保存验签公钥，签名私钥只应配置为 Worker Secret。

## 部署

1. 创建 D1 数据库并执行 `schema.sql`。
2. 将 `wrangler.toml.example` 复制为本地 `wrangler.toml`，填写数据库 ID。
3. 运行 `node generate-license-keys.js` 生成一组签名密钥。
4. 将 `LICENSE_PRIVATE_JWK` 和随机生成的 `ADMIN_TOKEN` 设置为 Worker Secrets。
5. 执行 `npx wrangler deploy --config cloudflare/wrangler.toml`。
6. 将公共验签密钥和 Worker URL 配置到你自己的客户端构建中。

## 文件

- `worker.js`：激活、验证和管理端激活码接口。
- `schema.sql`：D1 数据表。
- `wrangler.toml.example`：不含真实资源 ID 的部署配置示例。
- `generate-license-keys.js`：生成 P-256 签名私钥和客户端验签公钥。
- `public-license-key.json`：当前客户端使用的公共验签信息，不是秘密。

## 安全要求

不得提交或公开以下内容：

- `.secrets.local`
- `.license-private.jwk`
- `wrangler.toml`
- `generated-codes-*`
- 数据库导入、导出和管理员令牌

这些路径已加入仓库根目录的 `.gitignore`。公开密钥只能用于验证签名，不能用来
签发授权。
