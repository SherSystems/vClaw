# Contributing to vClaw

Thanks for your interest in contributing to vClaw! We welcome contributions from everyone.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/vclaw.git`
3. Install dependencies: `npm install`
4. Run tests to make sure everything works: `npm test`

## Development Setup

```bash
# Run in development mode
npm run dev

# Run tests in watch mode
npm run test:watch

# Type check
npm run lint

# Build
npm run build
```

## How to Contribute

### Bug Reports
- Use GitHub Issues
- Include steps to reproduce, expected behavior, and actual behavior
- Include your Node.js version, OS, and provider details (Proxmox/VMware version)

### Feature Requests
- Open a GitHub Discussion first to talk through the idea
- Describe the use case, not just the solution

### Code Contributions

1. Create a feature branch from `master`: `git checkout -b feat/my-feature`
2. Write tests for your changes
3. Make sure all tests pass: `npm test`
4. Keep commits focused and descriptive
5. Open a pull request against `master`

### Adding a New Provider

vClaw uses a plugin architecture for infrastructure providers. To add a new one:

1. Implement the `InfraAdapter` interface in `src/providers/`
2. Register your provider in the provider registry
3. Add tools for each operation your provider supports
4. Write tests (aim for at least 80% coverage of your provider)
5. Add configuration documentation to the README

See `src/providers/proxmox/` or `src/providers/vmware/` for reference implementations.

## Code Style

- TypeScript with strict mode
- Use descriptive variable and function names
- Keep functions small and focused
- Add comments only when the code isn't self-explanatory

## Testing

We take testing seriously. The project has 907+ tests and we want to keep that bar high.

- Every new feature needs tests
- Every bug fix needs a regression test
- Edge cases matter (see `tests/edge-cases/` for examples)

## Code of Conduct

Be respectful. Be constructive. We're all here to build something useful.

## Questions?

Open a GitHub Discussion or reach out at hello@shersystems.com.
