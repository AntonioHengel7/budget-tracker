output "instance_public_ip" {
  description = "SSH here (ubuntu@<ip>) or fetch /etc/rancher/k3s/k3s.yaml over SSH to get a local kubeconfig."
  value       = aws_instance.k3s.public_ip
}

output "ssh_command" {
  value = "ssh ubuntu@${aws_instance.k3s.public_ip}"
}
