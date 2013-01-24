require 'stella/logic'

class Stella::Logic::AddMachine < Stella::Logic::Base
  attr_reader :email, :name, :phone, :contact
  def raise_concerns(event=:add_contact)
    if !valid_email?(email)
      raise Stella::App::Problem.new("Inavlid email: #{email}")
    end
    if phone && !valid_phone?(phone)
      raise Stella::App::Problem.new("Inavlid phone: #{phone}")
    end
  end
  def process
    opts = {:email => email, :customer => cust}
    opts[:name] = name if name
    opts[:phone] = phone if phone
    @contact = Stella::Contact.create opts
  rescue DataObjects::IntegrityError => ex
    raise Stella::DuplicateItem, "That contact already exists"
  end
  def process_params
    @email = params[:email].to_s.strip
    @phone = params[:phone].to_s.strip
    @name = params[:name].to_s.strip
    @email = nil if @email.empty?
    @phone = nil if @phone.empty?
    @name = nil if @name.empty?
  end
end

class Stella::Logic::DeleteMachine < Stella::Logic::Base
  attr_reader :machineid, :machine
  def raise_concerns(event=:delete_machine)
    raise Stella::App::Problem, "No such machine" if machine.nil?
  end
  def process
    #contact.hosts.each { |host|
    #  Stella.ld '[contact-host-delete] %s for %s ' % [contact.email, host.hostname]
    #  host.contacts.delete contact
    #  contact.hosts.delete host
    #}
    #contact.save
    machine.destroy!
  end
  def process_params
    @machineid = params[:machineid].to_s.strip
    @machine = cust.remote_machines.first :machineid => machineid
  end
end

class Stella::Logic::TidyupMachine < Stella::Logic::Base
  attr_reader :machineid, :machine
  def raise_concerns(event=:update_contact)
    raise Stella::App::Problem, "No such machine" if machine.nil?
  end
  def process
    machine.worker_profiles(:status => :online).each { |worker|
      worker.status = worker.assumed_status
      worker.save
    }
    machine.worker_profiles(:status => :offline).destroy!
  end
  def process_params
    @machineid = params[:machineid].to_s.strip
    @machine = cust.remote_machines.first :machineid => machineid
  end
end
