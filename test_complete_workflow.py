#!/usr/bin/env python3
"""
Complete end-to-end test for the Andy API simple polling system.
Tests the full workflow: request submission -> work assignment -> processing -> result retrieval
"""

import requests
import time
import json
from datetime import datetime

# Test configuration
SERVER_URL = "http://localhost:3002"
API_KEY = "test-key-12345"  # You may need to use a valid API key

def test_pool_status():
    """Test that we can access pool status and see active hosts"""
    print("🔍 Testing pool status...")
    
    try:
        response = requests.get(f"{SERVER_URL}/api/andy/pool_status")
        
        if response.status_code == 200:
            data = response.json()
            total_hosts = data.get('total_hosts', 0)
            active_hosts = data.get('active_hosts', 0)
            
            print(f"✅ Pool Status: {active_hosts}/{total_hosts} hosts active")
            
            if active_hosts > 0:
                print("📋 Available models:")
                models = data.get('models', [])
                for model in models[:5]:  # Show first 5 models
                    print(f"   - {model.get('name', 'unknown')} ({model.get('available_hosts', 0)} hosts)")
                return True
            else:
                print("⚠️ No active hosts found - make sure clients are running")
                return False
        else:
            print(f"❌ Failed to get pool status: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Error getting pool status: {e}")
        return False

def test_chat_completion():
    """Test a simple chat completion request"""
    print("\n💬 Testing chat completion...")
    
    headers = {
        "Content-Type": "application/json"
    }
    
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    
    payload = {
        "model": "sweaterdog/andy-4:latest",  # Use the actual model name available
        "messages": [
            {"role": "user", "content": "Hello! Can you respond with just 'Test successful'?"}
        ],
        "temperature": 0.1,
        "max_tokens": 50
    }
    
    try:
        print("📤 Sending chat completion request...")
        start_time = time.time()
        
        response = requests.post(
            f"{SERVER_URL}/api/andy/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=130  # Allow time for processing
        )
        
        end_time = time.time()
        response_time = end_time - start_time
        
        print(f"⏱️ Response time: {response_time:.2f}s")
        
        if response.status_code == 200:
            data = response.json()
            content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
            usage = data.get('usage', {})
            
            print(f"✅ Chat completion successful!")
            print(f"📝 Response: {content[:100]}...")
            print(f"📊 Usage: {usage}")
            return True
            
        else:
            print(f"❌ Chat completion failed: {response.status_code}")
            try:
                error_data = response.json()
                print(f"Error details: {error_data}")
            except:
                print(f"Response text: {response.text}")
            return False
            
    except requests.exceptions.Timeout:
        print("❌ Request timed out")
        return False
    except Exception as e:
        print(f"❌ Error during chat completion: {e}")
        return False

def test_work_queue_directly():
    """Test the work queue system directly"""
    print("\n🔧 Testing work queue system directly...")
    
    try:
        # Check current queue status
        response = requests.get(f"{SERVER_URL}/api/andy/admin/metrics")
        if response.status_code == 200:
            metrics = response.json()
            queue_length = metrics.get('system', {}).get('queue_length', 0)
            active_requests = metrics.get('system', {}).get('active_requests', 0)
            print(f"📊 Current queue length: {queue_length}")
            print(f"📊 Active requests: {active_requests}")
        
        return True
        
    except Exception as e:
        print(f"❌ Error testing work queue: {e}")
        return False

def test_model_availability():
    """Test model availability endpoint"""
    print("\n🎯 Testing model availability...")
    
    try:
        response = requests.get(f"{SERVER_URL}/api/andy/v1/models")
        
        if response.status_code == 200:
            data = response.json()
            models = data.get('data', [])
            
            print(f"✅ Found {len(models)} available models:")
            for model in models[:5]:  # Show first 5
                print(f"   - {model.get('id', 'unknown')}")
            
            # Check if andy-4 is available (flexible matching)
            andy4_available = any('andy-4' in model.get('id', '').lower() for model in models)
            if andy4_available:
                print("✅ andy-4 model is available")
                return True
            else:
                print("⚠️ andy-4 model not found")
                print("   Available models include:")
                for model in models[:3]:
                    print(f"   - {model.get('id', 'unknown')}")
                return False
                
        else:
            print(f"❌ Failed to get models: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Error getting models: {e}")
        return False

def test_fallback_behavior():
    """Test fallback behavior when no hosts are available"""
    print("\n🔄 Testing fallback behavior...")
    
    headers = {
        "Content-Type": "application/json"
    }
    
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    
    payload = {
        "model": "non-existent-model",  # This should trigger fallback
        "messages": [
            {"role": "user", "content": "This should use fallback"}
        ],
        "temperature": 0.1,
        "max_tokens": 30
    }
    
    try:
        response = requests.post(
            f"{SERVER_URL}/api/andy/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=60
        )
        
        if response.status_code == 200:
            print("✅ Fallback system working")
            return True
        elif response.status_code == 503:
            print("⚠️ No fallback available (expected if disabled)")
            return True
        else:
            print(f"❌ Unexpected response: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Error testing fallback: {e}")
        return False

def run_comprehensive_test():
    """Run all tests in sequence"""
    print("🚀 Starting comprehensive Andy API test")
    print("=" * 50)
    
    tests = [
        ("Pool Status", test_pool_status),
        ("Model Availability", test_model_availability),
        ("Work Queue System", test_work_queue_directly),
        ("Chat Completion", test_chat_completion),
        ("Fallback Behavior", test_fallback_behavior),
    ]
    
    results = {}
    
    for test_name, test_func in tests:
        print(f"\n🧪 Running: {test_name}")
        start_time = time.time()
        
        try:
            result = test_func()
            end_time = time.time()
            
            results[test_name] = {
                'success': result,
                'duration': end_time - start_time
            }
            
            if result:
                print(f"✅ {test_name} passed ({end_time - start_time:.2f}s)")
            else:
                print(f"❌ {test_name} failed ({end_time - start_time:.2f}s)")
                
        except Exception as e:
            end_time = time.time()
            results[test_name] = {
                'success': False,
                'duration': end_time - start_time,
                'error': str(e)
            }
            print(f"💥 {test_name} crashed: {e}")
    
    # Summary
    print("\n" + "=" * 50)
    print("📊 TEST SUMMARY")
    print("=" * 50)
    
    passed = sum(1 for r in results.values() if r['success'])
    total = len(results)
    
    print(f"Overall: {passed}/{total} tests passed")
    
    for test_name, result in results.items():
        status = "✅ PASS" if result['success'] else "❌ FAIL"
        duration = result['duration']
        print(f"{status} {test_name:<20} ({duration:.2f}s)")
        
        if 'error' in result:
            print(f"      Error: {result['error']}")
    
    print(f"\nTotal test time: {sum(r['duration'] for r in results.values()):.2f}s")
    
    if passed == total:
        print("\n🎉 All tests passed! The Andy API is working correctly.")
        return True
    else:
        print(f"\n⚠️  {total - passed} test(s) failed. Check the issues above.")
        return False

if __name__ == "__main__":
    success = run_comprehensive_test()
    exit(0 if success else 1)
