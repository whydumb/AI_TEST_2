#!/usr/bin/env python3
"""
Test script for the simplified polling system
"""

import requests
import time
import json

def test_simple_polling():
    """Test the simple polling workflow"""
    server_url = "https://mindcraft.riqvip.dev"
    
    print("🧪 Testing Simple Polling System")
    print("=" * 50)
    
    # Step 1: Test pool status
    print("1. Checking pool status...")
    try:
        response = requests.get(f"{server_url}/api/andy/pool_status", timeout=10)
        if response.status_code == 200:
            pool_data = response.json()
            print(f"   ✅ Pool has {pool_data['active_hosts']} active hosts")
            print(f"   📊 Total models: {pool_data['total_models']}")
        else:
            print(f"   ❌ Pool status failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"   ❌ Error checking pool: {e}")
        return False
    
    # Step 2: Test simple work checking (should get 204 - no work)
    print("\n2. Testing work check endpoint...")
    try:
        response = requests.post(
            f"{server_url}/api/andy/check_for_work",
            json={
                "host_id": "test-host-simple",
                "models": ["andy-4", "sweaterdog/andy-4:latest"]
            },
            timeout=10
        )
        
        if response.status_code == 204:
            print("   ✅ No work available (expected)")
        elif response.status_code == 404:
            print("   ⚠️  Host not registered (expected for test)")
        else:
            print(f"   ❌ Unexpected response: {response.status_code}")
            print(f"      Response: {response.text}")
    except Exception as e:
        print(f"   ❌ Error checking for work: {e}")
    
    # Step 3: Test creating a work item and checking if it gets picked up
    print("\n3. Testing work flow...")
    
    # First, register a fake host
    try:
        response = requests.post(
            f"{server_url}/api/andy/join_pool",
            json={
                "host_id": "test-simple-host",
                "info": {
                    "models": [{"name": "andy-4", "quantization": "test"}],
                    "endpoint": "http://test:11434",
                    "capabilities": ["text"]
                }
            },
            timeout=10
        )
        
        if response.status_code == 200:
            print("   ✅ Test host registered")
            
            # Now check for work
            response = requests.post(
                f"{server_url}/api/andy/check_for_work",
                json={
                    "host_id": "test-simple-host",
                    "models": [{"name": "andy-4"}]
                },
                timeout=10
            )
            
            if response.status_code == 204:
                print("   ✅ No work available (expected)")
            elif response.status_code == 200:
                print("   📝 Work available!")
                work_data = response.json()
                print(f"      Work ID: {work_data.get('work_id')}")
            else:
                print(f"   ⚠️  Response: {response.status_code}")
            
            # Clean up
            requests.post(
                f"{server_url}/api/andy/leave_pool",
                json={"host_id": "test-simple-host"},
                timeout=10
            )
            print("   🧹 Test host removed")
            
        else:
            print(f"   ❌ Failed to register test host: {response.status_code}")
            
    except Exception as e:
        print(f"   ❌ Error in work flow test: {e}")
    
    # Step 4: Test actual API request to see fallback
    print("\n4. Testing chat completions endpoint...")
    try:
        response = requests.post(
            f"{server_url}/api/andy/v1/chat/completions",
            json={
                "model": "andy-4",
                "messages": [{"role": "user", "content": "Hello! Just testing the system."}],
                "max_tokens": 20
            },
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            print(f"   ✅ Chat completed!")
            print(f"      Response: {content[:100]}...")
        else:
            print(f"   ❌ Chat failed: {response.status_code}")
            print(f"      Response: {response.text[:200]}")
            
    except Exception as e:
        print(f"   ❌ Error testing chat: {e}")
    
    print("\n" + "=" * 50)
    print("🎯 Simple polling test completed!")

if __name__ == "__main__":
    test_simple_polling()
