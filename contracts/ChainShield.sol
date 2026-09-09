// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ChainShield
 * @notice On-chain policy registry + tamper-evident decision audit log.
 *
 * Every wallet can register a security policy. When a transaction intent
 * is evaluated off-chain, the resulting verdict can be recorded on-chain
 * as an immutable audit record viewable on BOTScan.
 *
 * Verdict values:
 *   0 = ALLOW
 *   1 = REQUIRE_HUMAN_CONFIRMATION
 *   2 = BLOCK
 */
contract ChainShield {
    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error InvalidVerdict();
    error InvalidRiskScore();
    error NotOwner();
    error Paused();
    error ArrayLengthMismatch();
    error ZeroAddressPolicy();

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event PolicySet(
        address indexed owner,
        uint256 maxTransfer,
        uint256 maxDailyOutflow,
        uint256 version,
        uint256 timestamp
    );

    event DecisionRecorded(
        bytes32 indexed intentHash,
        address indexed recorder,
        uint8 verdict,
        uint256 riskScore,
        uint256 timestamp
    );

    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);

    // ------------------------------------------------------------------
    // Data types
    // ------------------------------------------------------------------
    struct Policy {
        bool active;
        uint256 maxTransfer;      // in wei
        uint256 maxDailyOutflow;  // in wei
        uint256 version;
        uint256 updatedAt;
        address[] allowedDestinations;
        bytes4[] forbiddenSelectors;
        address[] tokens;         // tokens with non-zero approval caps
    }

    struct Record {
        uint8 verdict;
        uint256 riskScore;
        uint256 timestamp;
        address recorder;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    string public constant name = "ChainShield";
    uint256 public constant version = 1;

    address public owner;
    bool public paused;
    uint256 public recordCount;

    mapping(address => Policy) public policies;
    mapping(address => mapping(address => uint256)) public approvalCapByToken;
    mapping(bytes32 => Record) public records;

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------
    constructor() {
        owner = msg.sender;
    }

    // ------------------------------------------------------------------
    // Owner controls
    // ------------------------------------------------------------------
    function pause() external onlyOwner {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddressPolicy();
        owner = newOwner;
    }

    // ------------------------------------------------------------------
    // Policy registry
    // ------------------------------------------------------------------
    struct PolicyInput {
        bool active;
        uint256 maxTransfer;
        uint256 maxDailyOutflow;
        address[] allowedDestinations;
        bytes4[] forbiddenSelectors;
        address[] tokens;
        uint256[] caps;
    }

    /**
     * @notice Register or update the caller's own security policy.
     * @dev Each wallet controls exactly one policy keyed by msg.sender.
     */
    function setPolicy(PolicyInput calldata input) external whenNotPaused {
        if (input.tokens.length != input.caps.length) revert ArrayLengthMismatch();

        Policy storage p = policies[msg.sender];
        p.active = input.active;
        p.maxTransfer = input.maxTransfer;
        p.maxDailyOutflow = input.maxDailyOutflow;
        p.version = p.version + 1;
        p.updatedAt = block.timestamp;
        p.allowedDestinations = input.allowedDestinations;
        p.forbiddenSelectors = input.forbiddenSelectors;
        p.tokens = input.tokens;

        uint256 n = input.tokens.length;
        for (uint256 i = 0; i < n; ++i) {
            approvalCapByToken[msg.sender][input.tokens[i]] = input.caps[i];
        }

        emit PolicySet(
            msg.sender,
            input.maxTransfer,
            input.maxDailyOutflow,
            p.version,
            block.timestamp
        );
    }

    /**
     * @notice Convenience getter for a wallet's policy plus approval caps in one call.
     */
    function getPolicy(address policyOwner)
        external
        view
        returns (
            Policy memory policy,
            uint256[] memory caps
        )
    {
        policy = policies[policyOwner];
        uint256 n = policy.tokens.length;
        caps = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            caps[i] = approvalCapByToken[policyOwner][policy.tokens[i]];
        }
    }

    // ------------------------------------------------------------------
    // Decision audit log
    // ------------------------------------------------------------------
    /**
     * @notice Record the result of an off-chain risk-gate evaluation.
     * @param intentHash keccak256 digest of the evaluated transaction intent
     * @param verdict 0 = ALLOW, 1 = REQUIRE_HUMAN_CONFIRMATION, 2 = BLOCK
     * @param riskScore 0-100
     */
    function recordDecision(
        bytes32 intentHash,
        uint8 verdict,
        uint256 riskScore
    ) external whenNotPaused {
        if (verdict > 2) revert InvalidVerdict();
        if (riskScore > 100) revert InvalidRiskScore();

        records[intentHash] = Record(verdict, riskScore, block.timestamp, msg.sender);
        recordCount += 1;

        emit DecisionRecorded(intentHash, msg.sender, verdict, riskScore, block.timestamp);
    }
}
