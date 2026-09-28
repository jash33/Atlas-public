# Customer single sign-on

Atlas supports one customer organization and exactly one selected OpenID Connect provider per installation: Microsoft Entra ID, Google Workspace, or Okta. SAML and simultaneous providers are not supported. The backend handles OpenID Connect sign-in and keeps the browser session in an HTTP-only cookie. A successful provider login must also match an explicitly approved Atlas identity and organization membership. An email address, email domain, or directory group alone does not grant access.

This guide covers company sign-in. [Customer roles and access](customer-roles.md) documents Atlas's account-to-role mapping and permission rules. Atlas does not connect directly to LDAP or Active Directory; a customer using an on-premises directory must make the relevant accounts available through their selected provider using their existing directory integration.

## Standard self-hosted installation

The package in `infra/customer` runs PostgreSQL, the Atlas backend, and a prebuilt customer Console behind Caddy at one HTTPS origin. Every customer uses the same Console image. Organization and provider settings are backend runtime configuration; no customer-specific frontend compilation or interactive wizard is required.

This is the web and sign-in installation. Workflow execution also requires deployed Temporal services, customer Workers, execution signing keys, worker credentials, and customer secret storage. Those broader deployment requirements are tracked in #251; this package does not deploy an execution runtime or use the demo runtime. Complete #256 before customer release.

Use a supported Linux Docker host with Docker Compose, persistent storage, and a stable public DNS name such as `atlas.customer.example`. Point DNS at the host and permit inbound TCP 80/443 (and optionally UDP 443). Caddy obtains and renews HTTPS certificates automatically; see [Caddy's HTTPS requirements](https://caddyserver.com/docs/automatic-https). Keep database and backend ports private. The package publishes only the web ports. Back up the database, configuration, and Caddy certificate volume according to the customer's recovery requirements.

1. Obtain a reviewed Atlas release containing this package. Copy `infra/customer/.env.example` to `infra/customer/.env` and restrict that file to the installation operator.
2. Set `ATLAS_PUBLIC_ORIGIN`, `ATLAS_ORGANIZATION_NAME`, and `ATLAS_SSO_ORGANIZATION_ID`. Generate a unique 32-byte hex database password, for example with `openssl rand -hex 32`, and put it in `ATLAS_DATABASE_PASSWORD`. Hex avoids URL-encoding ambiguity. Never reuse a demo password.
3. Register the chosen identity provider using the next section, and put its settings in `.env`. Choose exactly one provider. Prefer the mounted secret-file option if the customer supplies secrets as files.
4. From the repository root, prepare the standard images. With release-provided images, set `ATLAS_BACKEND_IMAGE` and `ATLAS_CONSOLE_IMAGE` to the supplied immutable image references and run:

   ```sh
   docker compose --env-file infra/customer/.env -f infra/customer/compose.yaml pull backend console postgres
   ```

   If building from a source release, this builds the same provider-independent images for any installation; it does not embed the customer's `.env`:

   ```sh
   docker compose --env-file infra/customer/.env -f infra/customer/compose.yaml build backend console
   ```

5. Initialize and start the installation:

   ```sh
   docker compose --env-file infra/customer/.env -f infra/customer/compose.yaml up -d postgres
   docker compose --env-file infra/customer/.env -f infra/customer/compose.yaml run --rm init
   docker compose --env-file infra/customer/.env -f infra/customer/compose.yaml up -d backend console
   ```

The repeatable `init` command validates customer configuration, applies migrations, and creates the configured organization and development/production environments if missing. It does not create users or passwords, grant administrator access, or import demo data. Keep the same organization ID on subsequent runs.

For updates, back up the database first, obtain the next reviewed images, stop the backend and Console during migrations, rerun `init`, and start the new images. Do not delete the named data volumes. Operators using an existing HTTPS ingress can adapt the Caddy listener to their ingress, but must preserve the public origin, `/auth/*` and `/v1/*` routing, and secure cookies.

## Select and register one provider

Complete only the section for the customer's selected provider. Each uses the same exact HTTPS callback, `/auth/callback`, and a backend Web application with a client secret. Atlas requests `openid profile` and does not import directory groups.

### Microsoft Entra ID

1. Sign in to the customer's Microsoft Entra admin center. Select the intended workforce tenant, then open **Entra ID > App registrations > New registration**.
2. Name the app and choose the single-tenant account option. Record the **Application (client) ID** and **Directory (tenant) ID**. The registration must belong to the customer's tenant. See [Microsoft's app registration guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).
3. Under **Authentication**, add a **Web** platform with the exact redirect URI `https://atlas.customer.example/auth/callback`. Use the real Atlas origin and match the path and case exactly. Atlas handles the authorization code on the backend, so configure the Web platform. See [Microsoft's redirect URI guide](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri).
4. Under **Certificates & secrets**, create a client secret with an owner and expiry reminder. Securely transfer its **value** into the backend's secret store; the secret ID is not the credential. See [Microsoft's application credentials guide](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).
5. In **Enterprise apps**, select Atlas, then **Properties > Assignment required? > Yes**. Assign approved users or groups under **Users and groups**, and arrange the required tenant admin consent. Single tenant can include guest accounts; assignment and Atlas provisioning determine who actually gets access. Microsoft documents a Global Administrator exception to the assignment requirement, so retain Atlas's explicit identity check. See [Microsoft's assignment guide](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users).
6. Apply the customer's normal Entra multifactor authentication and access policies. Atlas requests `openid profile` for sign-in; it does not read directory groups or require Graph directory permissions for this feature.

### Google Workspace

1. Use a Google Cloud project owned by the customer's Workspace organization. In **Google Auth Platform > Branding**, configure the app name, support email, and contact details. Choose **Internal** under **Audience** for this organization-only installation. See [Google's OAuth consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent).
2. In **Google Auth Platform > Clients**, create a **Web application** OAuth client. Add `https://atlas.customer.example/auth/callback` as an authorized redirect URI, replacing the origin with the real installation. Store the client ID and secret in backend configuration. See [Google's web-server setup](https://developers.google.com/identity/protocols/oauth2/web-server).
3. Record the exact Google Workspace hosted domain to allow, for example `customer.example`. Atlas checks the signed ID token's `hd` claim against that domain; an email suffix or the login screen's domain hint is insufficient. Consumer Google accounts and other Workspace domains are rejected. The issuer is fixed to `https://accounts.google.com`. See [Google's OpenID Connect guidance](https://developers.google.com/identity/openid-connect/openid-connect).
4. Apply the customer's Workspace app-access and multifactor policies. Explicit Atlas provisioning is still required for each user.

### Okta

1. In the customer's Okta Admin Console, open **Applications and Resources > Applications > Create App Integration**. Select **OIDC - OpenID Connect** and **Web Application**. Use the authorization code grant and client-secret authentication with `client_secret_basic` (Okta's default). Atlas sends the app credentials using HTTP Basic authentication to the token endpoint. See [Okta's client authentication settings](https://developer.okta.com/docs/api/openapi/okta-oauth/guides/client-auth).
2. Set the sign-in redirect URI to `https://atlas.customer.example/auth/callback`, using the real installation origin. Save the client ID and client secret to the backend's protected configuration. Assign only approved users or groups to the app, and apply the customer's sign-in policies. See [Okta's web-app integration guide](https://developer.okta.com/docs/guides/sign-into-web-app-redirect/main/).
3. Use the **org authorization server** issuer: the exact HTTPS Okta organization origin, for example `https://customer.okta.com`. Custom domains are allowed when configured as the actual issuer. Do not append `/oauth2/default` or another authorization-server path: custom authorization servers are outside this integration. The discovery response and signed ID token must match this issuer. See [Okta's authorization-server reference](https://developer.okta.com/docs/concepts/auth-servers/).

## Configure the backend

Set these values in the backend service's protected configuration, then restart the service:

```dotenv
ATLAS_AUTH_MODE=customer
ATLAS_PUBLIC_ORIGIN=https://atlas.customer.example
ATLAS_SSO_PROVIDER=entra
ATLAS_SSO_TENANT_ID=11111111-1111-1111-1111-111111111111
ATLAS_SSO_CLIENT_ID=22222222-2222-2222-2222-222222222222
ATLAS_SSO_ORGANIZATION_ID=customer-organization-id
ATLAS_SSO_CLIENT_SECRET_FILE=/run/secrets/atlas-sso-client-secret
ATLAS_SESSION_MAX_AGE_SECONDS=28800
```

Use the customer's actual IDs. The secret file must be readable by the backend service and restricted to its operator. `ATLAS_SSO_CLIENT_SECRET` is available for secret managers that inject environment variables; do not configure both secret sources. Do not commit either the secret or database credentials. The origin must be an HTTPS origin without a path, query, or fragment. The session lifetime defaults to eight hours and cannot exceed 24 hours.

The example selects Entra. Keep the common settings and replace the provider settings with exactly one of these alternatives:

```dotenv
ATLAS_SSO_PROVIDER=google
ATLAS_SSO_GOOGLE_DOMAIN=customer.example
```

```dotenv
ATLAS_SSO_PROVIDER=okta
ATLAS_SSO_OKTA_ISSUER=https://customer.okta.com
```

Use that provider's client ID and secret. Remove the other providers' settings. Omitting `ATLAS_SSO_PROVIDER` preserves the original Entra configuration for existing installations; new installations should set it explicitly.

This implementation supports client secrets. Microsoft recommends certificate or federated credentials for production; installations requiring those credentials need additional backend support before deployment. See [Microsoft's credential guidance](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).

For Entra, Atlas pins the issuer to `https://login.microsoftonline.com/<tenant-id>/v2.0`; do not use Microsoft's `common` or `organizations` tenant aliases. Customer mode must remain enabled during setup and recovery. Switching to demo mode is not a recovery procedure.

The standard Console image is already built in customer mode and uses same-origin requests. No provider IDs, customer domains, or human tokens belong in its build. Remove backend human demo bearer-token settings; customer mode rejects them. Recreate the backend container after changing runtime settings.

## Approve the first administrator

The first administrator is approved by an authorized installation operator, never automatically chosen as the first visitor. There is no startup password or web recovery bypass.

1. The intended administrator opens Atlas and signs in with the selected company provider. Atlas verifies the provider token and organization restriction, then displays a pending access request with a request code. No Atlas session or permissions are granted yet.
2. The operator checks the request with the customer through a trusted channel and confirms which person should administer Atlas. The request code identifies the server-verified identity; the customer does not need to decode or copy ID tokens.
3. From the installation's protected operator shell, approve that exact request:

   ```sh
   docker compose --env-file infra/customer/.env -f infra/customer/compose.yaml exec backend node apps/backend/dist/customer-sso-admin.js --action approve-request --request REQUEST_CODE --role admin --operator "Operator name" --reason "Approved installation request"
   ```

4. The administrator signs in again. The new session has the approved Atlas membership. Approved requests cannot be reused.

The command reads the running backend's provider and organization configuration. Identity binding, membership, session revocation, and audit entry are transactional. An email match never automatically links an existing user. The database and container operator permissions are the authority for this initial approval; keep them restricted independently of company sign-in.

## Approve other users

An assigned company user signs in and receives a pending request. An Atlas administrator opens **Settings > Access requests** in the Console, verifies the intended person, and approves the request with the appropriate Atlas role or rejects it. The user signs in again after approval. Provider assignment alone does not grant Atlas access, and rejection does not create membership. Atlas maps the verified provider account to the approved role; it does not infer a role from an email address or browser data.

Authors can draft, edit, test, and run workflows; operators handle repairs; administrators manage connections, membership, approvals, and settings. Choose the role needed for the person's work. Removing a member revokes their sessions immediately. If that same provider identity later requests access again, an administrator must explicitly approve the new request; approval restores the retained Atlas user without matching email addresses.

## Enable password sign-in for an approved user

Password sign-in is optional and uses the same Atlas user, organization membership, role, and session checks as SSO. Approve the user through SSO first. Then place a password of at least 15 characters in a protected file available inside the backend container and run:

```sh
docker compose --env-file infra/customer/.env -f infra/customer/compose.yaml exec backend node apps/backend/dist/customer-password-admin.js --user-id USER_ID --username USERNAME --password-file /run/secrets/atlas-user-password
```

Usernames are case-insensitive. Atlas stores a unique random salt, the `scrypt` work settings, and the resulting password hash; it does not store the password. Re-running the command replaces that user's password, ends their password sessions, and leaves SSO identities untouched. Failed password attempts use one generic response and are temporarily locked after repeated failures.

Keep password files and access to this command restricted to the installation operator. SSO remains available through **Continue with SSO**, and removing the organization membership removes both password credentials and password sessions.

## Recovery and routine operations

- **Lost administrator access:** have the approved replacement identity sign in to create a fresh pending request. The operator verifies that person, then runs the same `approve-request` command with `--role admin --user-id EXISTING_ATLAS_USER_ID` and an explicit recovery reason. This deliberately binds the new verified identity to the existing user and removes old bindings and sessions for that user in the organization. Do not use matching email as recovery authority.
- **Revoke sessions:** the protected operator CLI supports `--action revoke-sessions` with organization, the selected provider flags, user ID, operator, and reason. The provider flags are `--provider entra --tenant TENANT_ID`, `--provider google --google-domain customer.example`, or `--provider okta --issuer https://customer.okta.com`. Revocation preserves membership, so remove membership and disable the provider assignment/account when removing access entirely.
- **Change provider:** use a maintenance window, revoke existing sessions, change the backend provider configuration, and restart it. Users sign in to create verified requests for the new provider; approve them explicitly, using the existing user ID only after verifying the intended mapping. Remove obsolete bindings rather than relying on email matching. Test rejection of old sessions before reopening access. Only the selected provider is available at a time.
- **Secret rotation:** replace the configured secret through the secret store and recreate the backend container before the old secret expires. Never put the value in an incident report. Revoke affected sessions separately when responding to a compromise.
- **Logout:** Atlas ends the local session. The provider may still have its own session, so the next login may not request a password. Follow the customer's provider procedures when ending directory-wide access.

Successful operator actions appear in membership audit history with the supplied operator and reason. Operator failures print a generic message to avoid exposing database details. Check the request state, configuration, migration level, and identity ownership in a protected operator session. Database/container access records should establish who actually ran the command.

## Troubleshooting

| Symptom                                   | Check                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider redirect URI error               | Web platform registration and the exact public `/auth/callback` URL.                                                                                |
| Client credential failure                 | Secret value rather than secret ID, expiry, tenant/client pair, and service access to the secret file.                                              |
| Provider signs in but Atlas denies access | Pending request status and administrator approval, the selected company restriction, and existing membership. Email matching does not grant access. |
| Login state expired or invalid            | Restart the login from Atlas, check browser cookies and HTTPS proxy settings, and avoid replaying old callbacks.                                    |
| Session disappears                        | Session expiry, logout/revocation, removal of membership/identity, and changed tenant/client/organization settings.                                 |
| Provider unavailable                      | Backend outbound HTTPS access to the selected provider's discovery, token, and signing-key endpoints; retry after service recovery.                 |

For support, record time, deployment version, the route and status, and the provider's nonsecret error/correlation ID where available. Remove cookies, client secrets, authorization codes, tokens, and callback query strings from logs and screenshots.

## Customer verification checklist

These checks require real customer credentials and tenant administrator access. Automated tests cannot establish that the customer's provider registration, proxy, consent, or access policies are correct. Record the date, deployment, tester, and result before sign-off:

- [ ] An assigned, provisioned customer user can sign in and reach the intended Atlas organization.
- [ ] The first administrator can use an existing admin-only operation; an ordinary user cannot.
- [ ] A user from another tenant, Workspace domain, or Okta organization is denied. Google consumer accounts are denied when Google is selected.
- [ ] A new company user receives a pending request and no Atlas access until approved. Rejected, expired, and already approved requests cannot grant access.
- [ ] The first administrator is approved through the operator command, and later users through the Console. A removed member cannot regain access without approval.
- [ ] Existing demo identity headers cannot select a user or organization in customer mode.
- [ ] Reload retains the session; logout ends it; an expired/revoked cookie is rejected.
- [ ] Failed, expired, and replayed callbacks do not create sessions or disclose credentials.
- [ ] The HTTPS proxy passes login and callback cookies correctly.
- [ ] An operator recovery exercise revokes the old session and allows only the approved replacement identity.
- [ ] Secret rotation succeeds and the owner has recorded its next expiry.
- [ ] Issues #255 and #256 are complete before customer release.
