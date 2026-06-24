# Deploying Symphonix Log Lens to AWS App Runner

This stands up the app as a single container on **AWS App Runner** — managed
HTTPS, a public URL, no servers to babysit. Artifacts:

- `Dockerfile` — production image (Node + git + built frontend)
- `.dockerignore` — keeps sample logs (PII!) and cruft out of the image
- `deploy/apprunner.cfn.yaml` — CloudFormation: App Runner service + IAM + 1-instance autoscaling

> ⚠️ **Read the Security section before sharing the URL.** This deployment is
> public with **no authentication** (a demo choice). The app ingests Salesforce
> FINEST logs (which contain **PII** — customer emails, balances, record IDs) and
> accepts **GitHub Personal Access Tokens**. Don't paste production logs or real
> tokens into a public, unauthenticated instance.

---

## Prerequisites

- AWS CLI v2, logged in (`aws sts get-caller-identity` works)
- Docker installed and running
- An AWS region — examples use `us-east-1`

Set a couple of shell variables (adjust as needed):

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPO=logplaybook
export IMAGE_TAG=v1
export IMAGE_URI=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG
```

---

## Step 1 — Create an ECR repository (once)

```bash
aws ecr create-repository \
  --repository-name "$ECR_REPO" \
  --region "$AWS_REGION" \
  --image-scanning-configuration scanOnPush=true
```

## Step 2 — Build and push the image

App Runner runs Linux/amd64. If you're on an Apple-silicon Mac, the
`--platform` flag matters.

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
    "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# Build for the App Runner architecture
docker build --platform linux/amd64 -t "$IMAGE_URI" .

# Push
docker push "$IMAGE_URI"
```

## Step 3 — Deploy the CloudFormation stack

```bash
aws cloudformation deploy \
  --stack-name symphonix-log-lens \
  --template-file deploy/apprunner.cfn.yaml \
  --capabilities CAPABILITY_IAM \
  --region "$AWS_REGION" \
  --parameter-overrides ImageUri="$IMAGE_URI"
```

First deploy takes a few minutes (App Runner provisions + health-checks). Get the
URL:

```bash
aws cloudformation describe-stacks \
  --stack-name symphonix-log-lens \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ServiceUrl'].OutputValue" \
  --output text
```

Open that `https://…awsapprunner.com` URL — you should see the drop-a-log screen.
`GET /api/health` returns `{"ok":true}`.

## Step 4 — Shipping updates

`AutoDeploymentsEnabled` is on, so re-pushing the **same tag** triggers a
redeploy:

```bash
docker build --platform linux/amd64 -t "$IMAGE_URI" .
docker push "$IMAGE_URI"   # App Runner picks it up automatically
```

(If you bump `IMAGE_TAG`, re-run the Step 3 `deploy` with the new `ImageUri`.)

---

## Multi-user isolation (per-session repos)

Each browser sends an `x-session-id` header, and the server keeps a **separate
cloned repo index per session**. So two people using the portal at the same time
get fully isolated repo state — one user's connect/disconnect never affects
another, and nobody can read another session's source. Idle sessions (and their
`/tmp` clones) are auto-evicted after 1 hour, and everything is wiped on restart.
Nothing is persisted.

## Why one instance?

The CloudFormation pins `MinSize = MaxSize = 1`. Session repo state lives in the
**instance's memory + `/tmp`**. With more than one instance, a session's parse
request could land on an instance that doesn't hold that session's clone, so
source links would intermittently break. One instance is correct for now. To
scale out later, externalize session/repo state (see "Scaling" below).

---

## Security — before this is anything but a demo

> Note: cloned repo source is now **scoped per browser session** (see
> "Multi-user isolation" above), so one user can't read another's connected repo
> even on a shared instance. The items below are still worth doing for a
> non-demo deployment.

The current deployment is **public + unauthenticated**. To make it safe:

1. **Put auth in front.** Options, simplest → most robust:
   - App Runner doesn't do built-in auth. Front it with **CloudFront + a Lambda@Edge / CloudFront Function** doing basic-auth, or
   - Switch to **ALB + ECS Fargate** and attach **Cognito / OIDC SSO** on the listener (ask me — I have the ECS template ready to adapt), or
   - Make ingress **private** (App Runner VPC ingress) so it's only reachable inside your network/VPN.
2. **Don't log secrets.** GitHub PATs are POSTed to `/api/repo`. They're used in-memory to clone and not persisted, but consider a short-lived, read-only, fine-scoped PAT and rotate it.
3. **Scope egress.** The container makes outbound HTTPS to `github.com` to clone. If you lock egress, allow that.
4. **Uploads are PII.** Logs are parsed in memory and not written to disk, but they transit the server. HTTPS (App Runner default) covers transit; auth covers access.
5. **Image hygiene.** `.dockerignore` already excludes the sample `*.log` / `*.txt` files so they never ship in the image — keep it that way.

---

## Scaling later (when one instance isn't enough)

The blocker is per-instance state. To go multi-instance:

- Move the **repo clone + index** to shared storage (EFS mount) or a small
  external store, keyed by repo, instead of per-process memory + `/tmp`; or
- Split the **parse API** (stateless, scales freely) from the **repo/source
  service** (stateful, single instance) and route `/api/source` + `/api/repo` to
  the latter.

Until then, one instance comfortably handles an internal dev/support team —
parsing a 20 MB log takes well under 100 ms.

---

## Teardown

```bash
aws cloudformation delete-stack --stack-name symphonix-log-lens --region "$AWS_REGION"
aws ecr delete-repository --repository-name "$ECR_REPO" --force --region "$AWS_REGION"
```
