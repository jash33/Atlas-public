# Capabilities

A capability is one API action Atlas can use in a workflow. **Get an invoice**, **settle a payment**, and **send a notification** are capabilities. A service can expose many of them.

Connecting an API gives Atlas a catalog of actions. Your team reviews which actions it may use, and a workflow puts those actions in order to accomplish something.

## What can a capability be?

Capabilities describe specific operations, with defined inputs and outputs. These are examples of actions an API could expose, not a list of preinstalled Atlas connectors.

| Kind of action   | Example                              | What to review                                                          |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Read information | Get a payment or look up an invoice  | Required identifiers, returned fields, and access to the data.          |
| Change a record  | Settle an invoice or update an order | Side effects, duplicate requests, and whether the action can be undone. |
| Send a message   | Notify an operations team            | Destination, credentials, and what happens if delivery is repeated.     |
| Publish an event | Announce that an invoice was settled | Message format, delivery behavior, and consumer expectations.           |

The current Console imports **OpenAPI JSON** documents. Atlas also represents event operations from registered AsyncAPI contracts. A contract being understood does not mean every protocol or transport can execute: check the operation's supported execution path, worker, credentials, and destination before planning around it. Do not assume a built-in connector exists for a product just because it has an API.

## What Atlas knows about an action

Open a capability in the **Capabilities** catalog to inspect its contract and approval details.

| Detail                                | Meaning                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Source                                | The API document Atlas learned the action from.                                    |
| Inputs and outputs                    | The fields the action accepts and returns, including their types and requirements. |
| Version                               | A saved definition of that action. A workflow uses an exact version.               |
| Environment                           | Where the action is available, such as Development or Production.                  |
| Approval and safety details           | Human-reviewed facts about retrying, duplicate handling, and irreversible effects. |
| Credential reference and allowed host | The named credential and destination the worker needs to call it.                  |
| Workflow references                   | The known workflows that depend on the action.                                     |

The API definition describes the contract. It does not prove that a deployed service behaves as described. Safety facts still need review by someone who understands the operation.

## Connect and approve an API

1. Choose the intended environment in the Console.
2. As an **Admin**, open **Capabilities** and choose **Connect Source**.
3. Paste an OpenAPI JSON document or choose its JSON file. Review the operations Atlas discovers.
4. Open an action and check its inputs, outputs, source, and current version.
5. Review safety details, including whether retries are safe, how repeated writes are handled, and whether another action can undo the result.
6. Configure the required credential reference and allowed destination for the environment, then approve the action.

Only actions that meet Atlas's current availability, approval, and execution requirements can be selected for a new workflow. Importing a source does not create a workflow or grant permission to call every operation in it.

## Capabilities and workflows

Think of a capability as **one action** and a workflow as **the reviewed plan that connects actions**.

For example, a payment workflow might read a payment, fetch its invoice, compare the amount and currency, settle the invoice, and notify operations. Each API call uses a capability. The workflow defines their order, data mappings, conditions, timeouts, and retry rules.

A broad business goal such as “onboard a customer” usually needs several capabilities. Atlas can help draft the workflow once the required actions have been connected and approved. It cannot invent access to a missing API.

## Versions and conflicting sources

When Atlas rediscovers a changed contract, it saves a new capability version. Existing workflows keep the exact versions they were approved with. They do not silently switch to the latest definition.

If two sources disagree about the same current action, the catalog shows **Conflicting sources** and excludes it from new plans. An Admin can review the candidates and select the authoritative source for that environment, or correct the registrations and clear that choice.

See [API changes](/concepts/api-changes/) for how affected workflows are reviewed.

## Remove a capability

An Admin can delete a capability from its details in the selected environment. Atlas refuses deletion if a saved workflow in the organization references any version of it.

Deletion hides the action in that environment and prevents new workflow compilation from using it. Historical versions and other environments remain. Rediscovery does not restore it, and there is currently no restore action. Check its workflow references before deleting it.
