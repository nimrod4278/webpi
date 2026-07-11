# Contributing to wepi

Thanks for your interest in contributing! wepi is an early-stage proof of
concept, so issues, ideas, and pull requests are all welcome.

## Getting set up

wepi is a [pnpm](https://pnpm.io/) monorepo. You need Node 22+ and pnpm.

```bash
pnpm install
pnpm --filter wepi-client fetch-assets   # pull the sandbox runtime blobs
pnpm --filter wepi-client dev            # run the example app
```

See [`docs/getting-started.md`](docs/getting-started.md) for a fuller tour.

## Before you open a pull request

Run the same checks CI runs:

```bash
pnpm -r build          # every package builds
pnpm -r typecheck      # no type errors
pnpm --filter wepi test
```

Please keep pull requests focused — one logical change per PR is much easier to
review. If your change is user-visible, update the README/docs in the same PR.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/), matching
the existing history, e.g.:

```
feat(client): component-based dashboard built by agent tool-calls
fix(sdk): repair invalid tool-call arguments before retry
docs: add multi-page SDK documentation
```

## Reporting bugs and requesting features

Open an [issue](https://github.com/nimrod4278/webpi/issues) using the provided
templates. For anything security-sensitive, see [`SECURITY.md`](SECURITY.md)
instead of filing a public issue.

## Licensing

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
