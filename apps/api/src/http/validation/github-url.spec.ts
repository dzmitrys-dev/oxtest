import { BadRequestException } from '@nestjs/common';

import type { CreateScanDto } from '../dto/create-scan.dto';
import { parseGithubUrl } from './github-url';
import { GithubUrlPipe } from './github-url.pipe';

describe('parseGithubUrl', () => {
  describe('accepts valid GitHub HTTPS URLs (D-01/D-02)', () => {
    const accept: Array<[string, { owner: string; repo: string }]> = [
      ['https://github.com/owner/repo', { owner: 'owner', repo: 'repo' }],
      ['https://github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
      [
        'https://www.github.com/owner/repo',
        { owner: 'owner', repo: 'repo' },
      ],
      [
        'https://github.com/octo-cat/my.tool_v2',
        { owner: 'octo-cat', repo: 'my.tool_v2' },
      ],
      [
        'https://github.com/owner/repo/',
        { owner: 'owner', repo: 'repo' },
      ],
    ];

    it.each(accept)('accepts %s', (input, expected) => {
      expect(parseGithubUrl(input)).toEqual(expected);
    });
  });

  describe('rejects invalid input (→ null, never throws)', () => {
    const reject: Array<[string, unknown]> = [
      ['non-string (number)', 123],
      ['non-string (object)', {}],
      ['non-string (undefined)', undefined],
      ['non-string (null)', null],
      ['empty string', ''],
      ['over-length (>2048)', `https://github.com/owner/${'a'.repeat(2100)}`],
      ['ssh scp-syntax', 'git@github.com:owner/repo.git'],
      ['git:// protocol', 'git://github.com/owner/repo'],
      ['file:// protocol', 'file:///etc/passwd'],
      ['http:// protocol', 'http://github.com/owner/repo'],
      ['userinfo present', 'https://user:pass@github.com/owner/repo'],
      ['non-standard port', 'https://github.com:8443/owner/repo'],
      ['look-alike host', 'https://github.com.evil.com/owner/repo'],
      ['non-github host', 'https://gitlab.com/owner/repo'],
      ['single-segment path', 'https://github.com/owner'],
      ['three-segment path', 'https://github.com/owner/repo/extra'],
      ['dot-dot repo', 'https://github.com/owner/..'],
      ['dot repo', 'https://github.com/owner/.'],
      ['garbage', 'not a url at all'],
      [
        'owner with leading hyphen',
        'https://github.com/-owner/repo',
      ],
      [
        'owner with double hyphen',
        'https://github.com/ow--ner/repo',
      ],
    ];

    it.each(reject)('rejects %s', (_label, input) => {
      expect(parseGithubUrl(input)).toBeNull();
    });

    it('never throws on any input', () => {
      expect(() => parseGithubUrl(Symbol('x') as unknown)).not.toThrow();
      expect(() => parseGithubUrl('git@github.com:o/r.git')).not.toThrow();
    });
  });
});

describe('GithubUrlPipe', () => {
  const pipe = new GithubUrlPipe();
  const meta = { type: 'body' as const };

  it('returns the CreateScanDto on a valid repoUrl', () => {
    const value: CreateScanDto = { repoUrl: 'https://github.com/owner/repo' };
    expect(pipe.transform(value, meta)).toEqual(value);
  });

  it('throws BadRequestException on an invalid repoUrl', () => {
    expect(() =>
      pipe.transform({ repoUrl: 'git://github.com/owner/repo' }, meta),
    ).toThrow(BadRequestException);
  });

  it('throws BadRequestException on an undefined body (400 before handler)', () => {
    expect(() => pipe.transform(undefined, meta)).toThrow(BadRequestException);
  });

  it('throws BadRequestException when repoUrl is missing', () => {
    expect(() => pipe.transform({}, meta)).toThrow(BadRequestException);
  });
});
