# Security Policy

## Supported versions

wepi is a proof of concept under active development. Only the latest `main` is
supported; fixes are not backported.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's
[private vulnerability reporting](https://github.com/nimrod4278/webpi/security/advisories/new),
or email **nimrod.feldman@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- affected version / commit.

You can expect an acknowledgement within a few days. Please give us reasonable
time to investigate and ship a fix before any public disclosure.

## Scope notes

wepi runs an agent and a `bash` sandbox **entirely in the browser** via
container2wasm. The VM is isolated in a Web Worker and has no host filesystem or
network access beyond what the page grants. Reports that meaningfully weaken that
isolation boundary, or that let page content escape the sandbox, are especially
valuable.
