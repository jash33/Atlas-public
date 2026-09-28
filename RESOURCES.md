# Resources

Use the application source and tests to check current behavior. These guides explain setup,
workflows, and the main design choices.

## Project documentation

| Resource | Covers |
| --- | --- |
| [Setup guide](README.md) | Local development, service layout, and verification commands. |
| [Developer course](apps/onboarding-site/README.md) | Application walkthrough and technical glossary. |
| [Repository analysis](docs/GITHUB_REPOSITORIES.md) | Reading public repositories and reviewing API contracts. |
| [Workflow checks](docs/workflow-checks.md) | Validation and checks before running a workflow. |
| [Workflow builder](docs/workflow-builder-design.md) | Workflow editing and review. |
| [Customer installation](docs/CUSTOMER_SSO_INSTALL.md) | Self-hosted web application and sign-in setup. |
| [Roles and access](docs/customer-roles.md) | Permissions for workflow authors, operators, and administrators. |
| [Notification delivery](docs/notification-delivery.md) | Change notifications and live updates. |

## External references

- [Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal): durable execution and replay.
- [Temporal workflow definitions](https://docs.temporal.io/workflow-definition): execution constraints.
- [OpenAPI specification](https://spec.openapis.org/oas/latest.html): HTTP API contracts.
- [AsyncAPI specification](https://www.asyncapi.com/docs/reference/specification/v3.0.0): event contracts.
- [JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785): repeatable JSON hashing.
- [Saga pattern](https://microservices.io/patterns/data/saga.html): compensation after partial failures.
