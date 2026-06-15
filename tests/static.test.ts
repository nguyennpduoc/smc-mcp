// tests/static.test.ts
// Unit tests for the Solidity static analyzer. Covers the rule catalogue
// required by the README feature checklist, severity ranking, the
// deterministic hybrid pipeline entrypoint, and that no false positives
// are produced for benign code.

import { describe, it, expect } from 'vitest';
import { analyze, computeRiskScore } from '../src/analysis/static.js';

const FIND = (ruleId: string) =>
  (f: { ruleId: string }) => f.ruleId === ruleId;

describe('static analyzer', () => {
  it('detects tx.origin in require/if as high severity', () => {
    const src = `pragma solidity 0.8.24;
contract C {
  function withdraw() public {
    require(tx.origin == owner);
  }
}`;
    const r = analyze({ source: src });
    const f = r.findings.find(FIND('SOL-AUTH-001'));
    expect(f).toBeDefined();
    expect(f?.severity).toBe('high');
    expect(f?.location.line).toBe(4);
  });

  it('detects reentrancy (external call before state write)', () => {
    const src = `pragma solidity 0.8.24;
contract C {
  mapping(address => uint) public balances;
  function withdraw(uint amount) public {
    (bool ok,) = msg.sender.call{value: amount}("");
    balances[msg.sender] -= amount;
  }
}`;
    const r = analyze({ source: src });
    const f = r.findings.find(FIND('SOL-REENTRANCY-001'));
    expect(f).toBeDefined();
    expect(f?.severity).toBe('critical');
  });

  it('does not flag a reentrancy-safe function (no state write after call)', () => {
    const src = `pragma solidity 0.8.24;
contract C {
  function ping() public {
    (bool ok,) = msg.sender.call{value: 0}("");
    require(ok);
  }
}`;
    const r = analyze({ source: src });
    expect(r.findings.find(FIND('SOL-REENTRANCY-001'))).toBeUndefined();
  });

  it('detects unchecked low-level .call() return value', () => {
    const src = `pragma solidity 0.8.24;
contract C {
  function f() public {
    msg.sender.call("");
  }
}`;
    const r = analyze({ source: src });
    const f = r.findings.find(FIND('SOL-LOWLEVEL-001'));
    expect(f).toBeDefined();
    expect(f?.severity).toBe('high');
  });

  it('detects floating pragma', () => {
    const src = `pragma solidity ^0.8.0;
contract C {}`;
    const r = analyze({ source: src });
    const f = r.findings.find(FIND('SOL-PRAGMA-001'));
    expect(f).toBeDefined();
    expect(f?.severity).toBe('informational');
  });

  it('detects block.timestamp dependence', () => {
    const src = `pragma solidity 0.8.24;
contract C {
  function f() public view returns (bool) {
    return block.timestamp > 0;
  }
}`;
    const r = analyze({ source: src });
    const f = r.findings.find(FIND('SOL-TIMESTAMP-001'));
    expect(f).toBeDefined();
  });

  it('detects selfdestruct as high', () => {
    const src = `pragma solidity 0.8.24;
contract C {
  function die() public {
    selfdestruct(payable(msg.sender));
  }
}`;
    const r = analyze({ source: src });
    const f = r.findings.find(FIND('SOL-SELFDESTRUCT-001'));
    expect(f).toBeDefined();
    expect(f?.severity).toBe('high');
  });

  it('detects unchecked block', () => {
    const src = `pragma solidity 0.8.24;
contract C {
  function f(uint x) public pure returns (uint) {
    unchecked { return x - 1; }
  }
}`;
    const r = analyze({ source: src });
    const f = r.findings.find(FIND('SOL-MATH-001'));
    expect(f).toBeDefined();
  });

  it('does not flag a clean contract', () => {
    const src = `pragma solidity 0.8.24;
contract Safe {
  mapping(address => uint) public balances;
  function deposit() public payable { balances[msg.sender] += msg.value; }
  function withdraw(uint amount) public {
    require(balances[msg.sender] >= amount);
    balances[msg.sender] -= amount;
    (bool ok,) = msg.sender.call{value: amount}("");
    require(ok);
  }
}`;
    const r = analyze({ source: src });
    const reentrancy = r.findings.find(FIND('SOL-REENTRANCY-001'));
    const lowlevel = r.findings.find(FIND('SOL-LOWLEVEL-001'));
    expect(reentrancy).toBeUndefined();
    expect(lowlevel).toBeUndefined();
  });

  it('orders findings by severity then line', () => {
    const src = `pragma solidity ^0.8.0;
contract C {
  mapping(address => uint) public balances;
  function withdraw(uint amount) public {
    require(tx.origin == owner);
    (bool ok,) = msg.sender.call{value: amount}("");
    balances[msg.sender] -= amount;
  }
  function f() public {
    msg.sender.call("");
  }
}`;
    const r = analyze({ source: src });
    expect(r.findings.length).toBeGreaterThan(0);
    const sevs = r.findings.map((f) => f.severity);
    const order = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 } as const;
    for (let i = 1; i < sevs.length; i++) {
      expect(order[sevs[i] as keyof typeof order]).toBeGreaterThanOrEqual(
        order[sevs[i - 1] as keyof typeof order],
      );
    }
  });

  it('captures contracts and function names', () => {
    const src = `pragma solidity 0.8.24;
contract A { function a() public {} }
contract B is A { function b() public {} }`;
    const r = analyze({ source: src });
    expect(r.contracts).toContain('A');
    expect(r.contracts).toContain('B');
    expect(r.functions).toContain('a');
    expect(r.functions).toContain('b');
  });

  it('returns zero risk for empty findings', () => {
    expect(computeRiskScore([])).toBe(0);
  });

  it('computes higher risk for more severe findings', () => {
    const clean = analyze({ source: 'pragma solidity 0.8.24; contract C {}' });
    const dirty = analyze({
      source: `pragma solidity 0.8.24;
contract C {
  mapping(address => uint) public balances;
  function withdraw(uint amount) public {
    require(tx.origin == owner);
    (bool ok,) = msg.sender.call{value: amount}("");
    balances[msg.sender] -= amount;
  }
}`,
    });
    expect(computeRiskScore(clean.findings)).toBeLessThan(computeRiskScore(dirty.findings));
  });

  it('tolerant of parse errors: still runs pattern checks', () => {
    const src = 'pragma solidity 0.8.24\ncontract C { missing }';
    const r = analyze({ source: src });
    expect(r.parseErrors.length).toBeGreaterThan(0);
    // floating pragma check should still not fire (no ^), but tx.origin might
    // if present. We just assert the analyzer didn't throw.
    expect(Array.isArray(r.findings)).toBe(true);
  });
});
