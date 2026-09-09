// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {ChainShield} from "../contracts/ChainShield.sol";

/**
 * Fork-test verification template for the live ChainShield deployment.
 * Drop this into a Foundry project, set DEPLOYED to the mainnet address,
 * and run: forge test --match-contract ChainShieldVerify -vvv --fork-url https://rpc.botchain.ai
 */
contract ChainShieldVerify is Test {
    ChainShield target;
    address constant DEPLOYED = 0x0E62a1e1116084a7B20C1e8155BF5EaE4ed56849;
    address constant DEPLOYER = 0x1238d1c6EAEA609cAb45D75eABC8FDB95f4047B1;
    address constant STRANGER = 0x1111111111111111111111111111111111111111;

    function setUp() public {
        vm.createSelectFork("https://rpc.botchain.ai");
        target = ChainShield(DEPLOYED);
    }

    // ---------- chain / bytecode ----------
    function test_chainIdMatches() public view {
        assertEq(block.chainid, 677, "wrong chain");
    }

    function test_contractHasCode() public view {
        assertGt(address(target).code.length, 0, "no code at address");
    }

    // ---------- read-only state checks ----------
    function test_name() public view {
        assertEq(target.name(), "ChainShield");
    }

    function test_version() public view {
        assertEq(target.version(), 1);
    }

    function test_owner() public view {
        assertEq(target.owner(), DEPLOYER);
    }

    function test_notPaused() public view {
        assertFalse(target.paused());
    }

    function test_recordCount() public view {
        assertGe(target.recordCount(), 1, "no decisions recorded");
    }

    function test_deployerPolicyActive() public view {
        (ChainShield.Policy memory policy,) = target.getPolicy(DEPLOYER);
        assertTrue(policy.active, "deployer policy not active");
        assertEq(policy.maxTransfer, 1 ether);
        assertEq(policy.allowedDestinations.length, 1);
    }

    // ---------- access-control tests ----------
    function test_strangerCannotPause() public {
        vm.startPrank(STRANGER);
        vm.expectRevert();
        target.pause();
        vm.stopPrank();
    }

    // ---------- state-changing write tests ----------
    function test_strangerCanRecordDecision() public {
        bytes32 intentHash = keccak256("forge-test");
        vm.startPrank(STRANGER);
        target.recordDecision(intentHash, 0, 50);
        vm.stopPrank();
        (uint8 verdict, uint256 riskScore,, address recorder) = target.records(intentHash);
        assertEq(verdict, 0);
        assertEq(riskScore, 50);
        assertEq(recorder, STRANGER);
    }
}
