## [2.0.0](https://github.com/sapieonic/CharmShot/compare/v1.2.0...v2.0.0) (2026-06-07)

### ⚠ BREAKING CHANGES

* POST /v1/webhooks/revenuecat is removed along with the
REVENUECAT_WEBHOOK_AUTH env var. Billing webhooks now arrive at
POST /v1/webhooks/razorpay (X-Razorpay-Signature auth) and only when
PAYMENTS_ENABLED=true.

Co-authored-by: Manas Nilorout <manasnilarout@gmail.com>
Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

### Features

* replace RevenueCat billing with Razorpay shell gated by PAYMENTS_ENABLED ([#10](https://github.com/sapieonic/CharmShot/issues/10)) ([2f354f2](https://github.com/sapieonic/CharmShot/commit/2f354f2f39708a5eb954c58176a66fb88e9b60f8))

## [1.2.0](https://github.com/sapieonic/CharmShot/compare/v1.1.0...v1.2.0) (2026-06-07)

### Features

* **observability:** integrate PostHog for analytics, AI traces, and logs ([#9](https://github.com/sapieonic/CharmShot/issues/9)) ([79a1231](https://github.com/sapieonic/CharmShot/commit/79a1231d93590e33db50bcdd49a26556b7c707fd))

## [1.1.0](https://github.com/sapieonic/CharmShot/compare/v1.0.0...v1.1.0) (2026-06-06)

### Features

* add OpenAI Images API provider (gpt-image-1) ([#8](https://github.com/sapieonic/CharmShot/issues/8)) ([ac15096](https://github.com/sapieonic/CharmShot/commit/ac150966d8dafac65d513c08f10ba94282b96a2b))

## 1.0.0 (2026-06-06)

### Features

* Add Docker Compose configuration for local development ([#2](https://github.com/sapieonic/CharmShot/issues/2)) ([8505bda](https://github.com/sapieonic/CharmShot/commit/8505bda809675704e71071d74d7bc409f1ea7839))
* add S3 provisioning, OpenAPI docs, and automated semantic-release versioning ([#3](https://github.com/sapieonic/CharmShot/issues/3)) ([8fc776e](https://github.com/sapieonic/CharmShot/commit/8fc776e7045e4f5830515454645649081a442cf7))
* CharmShot backend: identity-preserving AI image generation server ([#1](https://github.com/sapieonic/CharmShot/issues/1)) ([7be7a45](https://github.com/sapieonic/CharmShot/commit/7be7a45dc037c74965a481ec9b478528161647bd))
* integrate Nano Banana 2 (Gemini 3.1 Flash Image) provider ([#4](https://github.com/sapieonic/CharmShot/issues/4)) ([3a012f0](https://github.com/sapieonic/CharmShot/commit/3a012f016c4a84f151874f008a3ab57863bfb8f5))

### Bug Fixes

* **ci:** disable Husky hooks during semantic-release commit ([#6](https://github.com/sapieonic/CharmShot/issues/6)) ([558582d](https://github.com/sapieonic/CharmShot/commit/558582dd6c97ed48520fa93a0cfa1ad8ded53864))
* switch release workflow from pull_request to push trigger ([#5](https://github.com/sapieonic/CharmShot/issues/5)) ([ebf9c82](https://github.com/sapieonic/CharmShot/commit/ebf9c8207c2a64bda75c0d2c0b3f0c577c8bd39f))
