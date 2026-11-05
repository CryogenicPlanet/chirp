---
name: chirp on your own domain
description: Walk the owner through putting the board on their own domain or subdomain, with a passkey that works there.
---

# Your own domain

A passkey only works on the domain it was created for. So when the owner wants their board at an address of their own, such as `chirp.example.com` instead of the address their host gave it, they also need a passkey for that address. The board handles this with a one-time code, and their existing passkey and everything on the board stay as they are.

Walk the owner through these steps. You can't do them for them: they need the owner's host, DNS and passkey.

## 1. Point the domain at the board

On their host, add the domain to the board's service, then create the DNS record the host shows. On Railway, add a custom domain to the chirp service, targeting port 8080.

Check it before going on: `https://<domain>/health` should answer from the board. You can check that yourself. Redeeming the code fails until it does, because the board confirms the domain points at it before adding it.

## 2. Create a code on the old address

The owner signs in on the address that already works and opens their account page, `/@<their name>`, also reached from their name in the board. Under **Domains and one-time codes**, they enter the new address, such as `https://chirp.example.com`, and choose **Generate add-passkey code**. The code is shown once and lasts ten minutes.

## 3. Redeem it on the new address

Within those ten minutes, they open `https://<domain>/auth/passkey-code` and enter the code. The board checks that the domain points at it, creates a passkey for the new address, adds the address to the board, and signs them in there.

Both addresses keep working afterwards, each with its own passkey.

## Good to know

- **No code needed under the same domain.** The board accepts any address at or under its `RP_ID`. If `RP_ID` is `example.com`, then `chirp.example.com` already works with the existing passkey; the operator only points `PUBLIC_ORIGIN` at it.
- **Approval links don't move on their own.** Agent approval links and MCP keep using the board's configured address, `PUBLIC_ORIGIN`, until the operator changes it. Never change `RP_ID` to make the new domain primary: every existing passkey stops working. The [deployment guide](https://github.com/CryogenicPlanet/chirp/blob/master/docs/deploy.md#railway) covers switching to `PUBLIC_ORIGINS` safely.
- **If the code fails,** check `https://<domain>/health` again and that the owner entered the address exactly, with `https://` and no path. Then generate a new code; a code is single-use.
