#!/bin/sh
# Test-only workspace: four invented projects with just enough files for the model to read and edit. Runs inside the test Webapp container (tools/test-webapp) as the hermes user.
set -eu
W=/opt/data/workspace
mkdir -p "$W"

mk() { mkdir -p "$(dirname "$1")"; cat > "$1"; }

# acme-shop: a small TypeScript storefront.
mk $W/acme-shop/package.json <<'EOF'
{ "name": "acme-shop", "version": "2.3.1", "private": true,
  "scripts": { "dev": "vite", "build": "tsc && vite build", "test": "vitest run" },
  "dependencies": { "react": "19.2.0", "react-dom": "19.2.0", "zod": "3.25.0" },
  "devDependencies": { "typescript": "5.9.2", "vite": "7.1.0", "vitest": "3.2.4" } }
EOF
mk $W/acme-shop/README.md <<'EOF'
# Acme Shop
Storefront for Acme's outdoor gear. React + Vite, prices in cents, cart persisted in localStorage.
EOF
mk $W/acme-shop/CHANGELOG.md <<'EOF'
## 2.3.1
- Fix rounding of discounted prices in the cart summary.
## 2.3.0
- Gift cards at checkout.
- Free shipping threshold configurable per country.
EOF
mk $W/acme-shop/src/cart.ts <<'EOF'
export type Line = { sku: string; unitCents: number; qty: number; discountPct?: number };

export function lineTotal(line: Line): number {
  const gross = line.unitCents * line.qty;
  return Math.round(gross * (1 - (line.discountPct ?? 0) / 100));
}

export function cartTotal(lines: Line[], shippingCents: number, freeShippingFromCents = 5000): number {
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  return subtotal + (subtotal >= freeShippingFromCents ? 0 : shippingCents);
}
EOF
mk $W/acme-shop/src/checkout.ts <<'EOF'
import { z } from 'zod';
export const Address = z.object({ name: z.string().min(1), street: z.string(), zip: z.string().regex(/^\d{5}$/), country: z.string().length(2) });
export type Address = z.infer<typeof Address>;
// TODO: gift card balance is not re-validated after the address step.
export function canPlaceOrder(address: unknown, giftCardCents: number, totalCents: number): boolean {
  return Address.safeParse(address).success && giftCardCents <= totalCents;
}
EOF

# infra: Terraform and Kubernetes for the shop.
mk $W/infra/main.tf <<'EOF'
terraform { required_version = ">= 1.9" }
module "shop_cluster" {
  source       = "./modules/cluster"
  name         = "acme-prod"
  node_count   = 3
  machine_type = "e2-standard-4"
}
EOF
mk $W/infra/k8s/shop-deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: acme-shop, namespace: shop }
spec:
  replicas: 2
  selector: { matchLabels: { app: acme-shop } }
  template:
    metadata: { labels: { app: acme-shop } }
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/acme-shop:2.3.1
          resources: { requests: { cpu: 250m, memory: 256Mi }, limits: { memory: 512Mi } }
          readinessProbe: { httpGet: { path: /healthz, port: 8080 } }
EOF
mk $W/infra/RUNBOOK.md <<'EOF'
# On-call runbook
1. Check the shop dashboard for 5xx and p95 latency.
2. `kubectl -n shop rollout status deploy/acme-shop`
3. Roll back with `kubectl -n shop rollout undo deploy/acme-shop`.
EOF

# mobile-app: the companion app.
mk $W/mobile-app/README.md <<'EOF'
# Acme mobile
React Native companion app: order tracking and push notifications.
EOF
mk $W/mobile-app/src/notifications.ts <<'EOF'
export function shouldNotify(status: string, quietHours: [number, number], hour: number): boolean {
  const [from, to] = quietHours;
  const quiet = from < to ? hour >= from && hour < to : hour >= from || hour < to;
  return status === 'shipped' && !quiet;
}
EOF

# docs-site: product documentation.
mk $W/docs-site/docs/getting-started.md <<'EOF'
# Getting started
Create an account, add a payment method, then place your first order.
EOF
mk $W/docs-site/docs/returns.md <<'EOF'
# Returns
Items can be returned within 30 days. Gift cards are not refundable.
EOF

for d in acme-shop infra mobile-app docs-site; do
  if [ ! -d "$W/$d/.git" ]; then
    git -C "$W/$d" init -q -b main && git -C "$W/$d" add -A && git -C "$W/$d" -c user.name=Demo -c user.email=demo@example.invalid commit -qm "Initial import"
  fi
done

# Re-running keeps projects that already exist: Hermes refuses a second project on the same folder.
project() { hermes project list 2>/dev/null | grep -qF " $1  [" || hermes project create "$1" "$2" --icon "$3" --color "$4" --description "$5" >/dev/null; }
project "Acme Shop" "$W/acme-shop" repo '#345bfb' "Storefront"
project "Infra" "$W/infra" cloud '#1cc6a2' "Terraform and Kubernetes"
project "Mobile App" "$W/mobile-app" device-mobile '#e08614' "Companion app"
project "Docs" "$W/docs-site" book '#ab5bfc' "Product documentation"
hermes project list
