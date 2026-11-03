// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, Button, cn } from '../src';

describe('cn', () => {
  it('merges conflicting tailwind classes but keeps custom tokens', () => {
    expect(cn('px-2 text-ui', 'px-4')).toBe('text-ui px-4');
    const hidden: boolean = Math.random() > 2;
    expect(cn('text-ui text-ink', hidden && 'hidden')).toBe('text-ui text-ink');
  });
});

describe('components', () => {
  it('renders buttons as type=button by default', () => {
    render(<Button variant="primary">Compile</Button>);
    const button = screen.getByRole('button', { name: 'Compile' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('bg-accent');
  });

  it('renders badges with tones', () => {
    render(<Badge tone="danger">3</Badge>);
    expect(screen.getByText('3').className).toContain('text-danger');
  });
});
