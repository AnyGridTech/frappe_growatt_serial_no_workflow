"use strict"
import { DialogInstance } from "@anygridtech/frappe-types/client/frappe/ui/Dialog";
import { SerialNo, SerialNoWorkflow, Workflow } from "@anygridtech/frappe-agt-types/agt/doctype";
import { FrappeForm } from "@anygridtech/frappe-types/client/frappe/core";

let is_force_state_allowed: boolean = false;
let allowedRoles = ['Information Technology User', 'Administrator', 'System Manager'];

const OUTPUT_INFO_MESSAGE = {
  SN_NOT_FOUND: "SN não encontrado.",
  SN_FOUND_ERP: "SN encontrado na base do ERPNext.",
  SN_FOUND_GROWATT: "SN encontrado na base da Growatt.",
  SN_INVALID: "Número de série inválido.",
  SN_DUPLICATED: "Número de série duplicado.",
  INPUT_VALIDATION_ERROR: "Erro ao validar entrada.",
  INVALID_WORKFLOW_TRANSITION: "Transição de workflow state inválida.",
}


frappe.ui.form.on('Serial No Workflow', {
  refresh: async function (form) {
    form.set_df_property('next_step', 'options', []); // Limpa as opções anteriores do campo 'next_step'.
    // Busca o workflow relacionado ao doctype 'Serial No' e que está ativo
    const sn_workflow = await frappe
      .call<{ docs: Workflow[] }>({
        method: 'frappe.client.get_list',
        args: {
          doctype: 'Workflow',
          filters: [
            ["Workflow", "document_type", "=", "Serial No"],
            ["Workflow", "is_active", "=", 1]
          ],
          limit_page_length: 1
        }
      })
      .catch(e => console.error(e))
      .then(async r => {
        if (r?.docs && Array.isArray(r.docs) && r.docs.length && r.docs[0]?.name) {
          // Carrega o documento completo do workflow encontrado
          return await frappe.call<{ docs: Workflow[] }>({
            method: 'frappe.desk.form.load.getdoc',
            args: {
              doctype: 'Workflow',
              name: r.docs[0].name
            }
          }).then(res => res?.docs[0]);
        }
        return null;
      });

    if (!sn_workflow) return frappe.throw('Workflow not found.'); // Se o Workflow não for encontrado, lança um erro.
    const workflow_transitions = sn_workflow.transitions // Obtém as transições definidas no Workflow.
    const user_roles = frappe.boot.user.roles; // Obtém as roles (funções) do usuário atual.
    const next_step_options = [] as string[]; // Cria um array para armazenar as opções do campo 'next_step'.

    const allowed_workflow_transitions = workflow_transitions.filter((t) => user_roles.includes(t.allowed))
    outterLoop:
    for (let allowed_transition of allowed_workflow_transitions) {
      if (next_step_options.includes(allowed_transition.next_state)) continue outterLoop;
      next_step_options.push(allowed_transition.next_state)
    }

    form.set_df_property('next_step', 'options', next_step_options); // Define as opções do campo 'next_step' no formulário.

    async function OnClickValidate(dialog: DialogInstance) {
      const serialNumberField = dialog.get_field('serialno_text-field'); // Obtém o campo de texto com os números de série.
      const serialNumbers = (serialNumberField && typeof serialNumberField['get_value'] === 'function')
        ? String(serialNumberField['get_value']() || '')
            .split('\n')
            .map((sn: string) => sn.trim())
            .filter((sn: string) => sn !== '')
        : [];

      if (!serialNumbers || serialNumbers.length === 0) {
        frappe.msgprint('⚠️ Por favor, insira um número de série.'); // Exibe mensagem se nenhum número de série for inserido.
        return;
      }

      const selectedState = form.doc.next_step; // Obtém a ação selecionada pelo usuário no campo 'next_step' do formulário.
      if (!selectedState) {
        frappe.msgprint('⚠️ Por favor, selecione o próximo passo do workflow.'); // Exibe mensagem se nenhuma ação for selecionada.
        return;
      }

      const modal = new agt.ui.UltraDialog({
        title: "Validando SN...",
        message: "",
        visible: false
      })
      modal.set_state('waiting');

      dialog.get_field('serialno_validate')['df'].disabled = 1; // Desabilita o botão "Validar" para evitar cliques múltiplos.
      form.refresh(); // Atualiza a interface do diálogo.
      dialog.hide(); // close the previous dialogue
      dialog.clear(); // clear the previous dialogue 

      async function validateAndDisplayMessage(serialNumber: string) {
        const existingSn = form.doc.serial_no_table
          .some((child: any) => child.serial_no === serialNumber);
        if (existingSn) {
          return `<b>${serialNumber}:</b>❌ Este número de série já foi inserido.`;
        }
        // Função para validar um número de série, determinar o próximo estado do workflow e exibir mensagens.
        let message = '';
        let modelInfo = '';
        let modelName = '';
        let companyName = '';
        let isValid = false;
        let outputInfo = ''; // Variável para armazenar a mensagem de output_info

        if (!agt.growatt.sn_regex.test(serialNumber)) {
          // Verifica se o número de série é válido usando uma expressão regular.
          message = `<b>${serialNumber}:</b>⚠️ Número de série inválido.`;
          outputInfo = OUTPUT_INFO_MESSAGE.SN_INVALID; // Define output_info para erro de regex
        } else {
          try {
            const { item, snInfo, printError } = await CheckSerialNumber(serialNumber); // Chama a função para verificar o número de série no banco de dados ou na API da Growatt.
            if (printError) {
              message = `<b>${serialNumber}: </b>❌ ${printError}`;
              outputInfo = printError; // Define output_info para erro da função CheckSerialNumber
            } else if (!snInfo && !item) {
              message = `<b>${serialNumber}: </b>` + OUTPUT_INFO_MESSAGE.SN_NOT_FOUND;
              outputInfo = OUTPUT_INFO_MESSAGE.SN_NOT_FOUND; // Define output_info para SN não encontrado
            } else if (item && snInfo) {
              message = `<b>${serialNumber}: </b>` + OUTPUT_INFO_MESSAGE.SN_FOUND_ERP;
              outputInfo = OUTPUT_INFO_MESSAGE.SN_FOUND_ERP; // Define output_info para sucesso no banco de dados do ERP.

              if (snInfo && snInfo.item_code) {
                modelInfo = snInfo.item_code;
              }
              if (snInfo && snInfo.item_name) {
                modelName = snInfo.item_name;
              }
              if (snInfo && snInfo.company) {
                companyName = snInfo.company;
              }

              isValid = true;

            } else if (item && !snInfo) {
              message = `<b>${serialNumber}:</b>✔️ SN encontrado na base da Growatt.`;
              outputInfo = OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT; // Define output_info para sucesso na base da Growatt
              modelInfo = item.item_code;
              modelName = item.item_name;
              isValid = true;
            }

            if (snInfo) {
              // Se o SN foi encontrado no banco de dados ERPNext.
              if (!sn_workflow) return frappe.throw('Workflow not found.');
              // Verifica se há transição válida do estado atual para o estado selecionado
              const available_transitions = sn_workflow.transitions.filter(
                transition =>
                  transition.state === snInfo.workflow_state &&
                  transition.next_state === selectedState
              );

              // Se NÃO houver transições válidas E NÃO for forçado, então bloqueia
              if (!available_transitions.length && !is_force_state_allowed) {
                const allowedStates = workflow_transitions
                  .filter(t => t.state === snInfo.workflow_state)
                  .map(t => t.next_state)
                  .filter((value, index, self) => self.indexOf(value) === index);

                message = `<b>${serialNumber}:</b>❌ SN encontrado no ERP, mas a transição de status é inválida. <b>Estado atual: </b> ${snInfo.workflow_state}, <b>Próximo selecionado: </b> ${selectedState}. <b>Estado(s) permitido(s): </b> ${allowedStates.join(', ')}.`;
                outputInfo = OUTPUT_INFO_MESSAGE.INVALID_WORKFLOW_TRANSITION;
                isValid = false;
              }
            }

            const existingSn = form.doc.serial_no_table.some((child: any) => child.serial_no === serialNumber); // Verifica se o SN já existe na tabela do formulário.
            if (existingSn) {
              message = `<b>${serialNumber}:</b>❌ Este número de série já foi inserido.`;
              outputInfo = OUTPUT_INFO_MESSAGE.SN_DUPLICATED; // Define output_info para SN já inserido
              isValid = false;
            }

            const existingEmptyRow = form.doc.serial_no_table.find((child: any) => !child.serial_no);  //Verifica se existe uma linha vazia.

            const child = existingEmptyRow || frappe.model.add_child(form.doc, 'serial_no_table'); // Adiciona uma nova linha à tabela 'serial_no_table' do formulário (ou usa uma linha vazia).

            child.serial_no = serialNumber; // Preenche os campos da linha com os dados do SN.
            child.item_code = modelInfo;
            child.item_name = modelName;
            child.company = companyName;
            child.next_step = selectedState; // **IMPORTANTE:** Define o 'next_step' com o próximo *estado* do workflow (não a ação).
            child.current_workflow_state = snInfo?.workflow_state || ''; // Define o estado atual do SN (ou vazio se não encontrado).
            child.output_info = outputInfo; // Define o campo output_info com a mensagem apropriada

            if (isValid) {
              child.is_valid = 1;
            } else {
              child.is_valid = 0; // Desativa o box de sucesso para casos de insucesso
            }

            form.refresh_field('serial_no_table'); // Atualiza a tabela no formulário.
          } catch (error) {
            console.error('Erro ao validar o número de série:', error);
            message = `<b>${serialNumber}:</b>❌ Erro ao validar.`;
            outputInfo = "Erro ao validar."; // Define output_info para erro geral de validação
            const existingEmptyRow = form.doc.serial_no_table.find((child: any) => !child.serial_no);
            const child = existingEmptyRow || frappe.model.add_child(form.doc, 'serial_no_table');
            child.serial_no = serialNumber;
            child.output_info = outputInfo;
            child.is_valid = 0;
            form.refresh_field('serial_no_table');
          }
        }

        if (modelInfo) {
          message += `(Eq: ${modelName}, Cód: ${modelInfo})`;
        }

        return message;

      }

      try {
        for (const serialNumber of serialNumbers) {
          // Iterate each SN
          const msg = await validateAndDisplayMessage(serialNumber);
          modal.set_message(`${msg}`);
          modal.visible(true);
          modal.set_state('waiting');
        }
        modal.set_title("Análise Finalizada");
        modal.set_message("<div style='color:green;'>✔️ Processo finalizado!</div>");
        modal.set_state('default');
      } catch (error) {
        // Catching general errors
        modal.set_title("Análise Finalizada");
        modal.set_message(`<div style='color:red;'>❌ Erro geral: ${error}</div>`);
        modal.set_state('default');
      } finally {
        dialog.get_field('serialno_validate')['df'].disabled = 0; // Allow "Validate" button again.
        form.refresh(); // Update dialogue's interface.
      }
    }

    form.fields_dict['add_sn']?.$wrapper?.off('click').on('click', () => {
      const diagTitle = 'Adicionar SN';
      try {
        const dialog = agt.utils.dialog.load({
          title: diagTitle,
          fields: [
            {
              label: `<b>📷 Escanear código de barras</b><p><span class="text-muted small" style="font-size: 0.7em;">Clique para ativar o scanner de código de barras.</span></p>`,
              fieldname: 'serialno_scan-barcode',
              fieldtype: 'Button',
              reqd: false,
              click: () => {
                try {
                  new frappe.ui.Scanner({
                    dialog: true,
                    multiple: false,
                    on_scan(data) {
                      // agt.utils.refresh_dialog_stacking();
                      if (data && data.result && data.result.text) {
                        const snField = dialog?.get_field('serialno_text-field');
                        const currentValue = String(snField?.['get_value']() ?? '');
                        const newValue = currentValue ? currentValue + '\n' + data.result.text : data.result.text;
                        snField?.['set_input'](newValue);
                      }
                    }
                  });
                } catch (scannerError) {
                  console.error("Error initializing scanner:", scannerError);
                  frappe.msgprint(__("Não foi possível iniciar o scanner. Verifique as permissões da câmera ou se há uma câmera disponível."));
                  frappe.show_alert({ message: 'Não foi possível iniciar o scanner. Verifique as permissões da câmera ou se há uma câmera disponível.', indicator: 'red' });
                }
              }
            },
            {
              label: `<b>Serial Number</b>`,
              fieldname: 'serialno_text-field',
              fieldtype: 'Text',
              placeholder: 'Insira o número de série manualmente ou escaneie o código de barras.'
            },
            {
              label: 'Validar',
              fieldname: 'serialno_validate',
              fieldtype: 'Button',
              reqd: false,
              primary: true,
              click: () => OnClickValidate(dialog)
            }
          ],
          static: false,
          lockClose: true,
          draggable: true,
        });
      } catch (error) {
        console.error("Error creating or showing the 'Adicionar SN' dialog:", error);
        frappe.msgprint(__("Erro ao abrir a janela de adição de SN. Verifique o console para detalhes."));
      }
    });
  }
});

agt.utils.dialog.close_all(); // Fecha todos os dialogos antes de chamar a função on click validate

// frappe.ui.form.on('Serial No Workflow', {
//   next_step: async function (form) {
//     // O evento next_step não precisa realizar ações agora. A ação selecionada é usada diretamente em outras funções.
//   }
// });

async function CheckSerialNumber(
  sn: string
): Promise<{ item: any | undefined; snInfo: SerialNo | undefined; printError: string }> {
  // Função para verificar um número de série, primeiro no banco de dados e, se não encontrado, na API da Growatt.
  let printError = '';
  const snInfo = await get_sn_info(sn); // Tenta obter informações do SN no banco de dados.

  if (!snInfo || Object.keys(snInfo).length === 0) {
    // Se o SN não for encontrado no banco de dados.
    const sn2 = await agt.utils.get_growatt_sn_info(sn); // Tenta obter informações do SN na API da Growatt (função externa).
    if (!sn2) {
      return { item: undefined, snInfo: undefined, printError };
    }

    const item = await agt.utils.get_item_info(sn2.data.model) //Obtem informações relacionadas ao item na API (função externa)

    return { item: item, snInfo: undefined, printError };
  }

  return { item: {}, snInfo: snInfo, printError: '' }; // Se o SN for encontrado no banco, retorna as informações.
}

async function get_sn_info(serialNumber: string) {
  // Função para obter informações de um número de série no banco de dados do ERPNext.
  return await frappe.db
    .get_value<SerialNo>('Serial No', { serial_no: serialNumber }, ['workflow_state', 'item_code', 'item_name', 'company'])
    .then(r => r?.message || null); // Retorna os valores ou null se não encontrado.
}

frappe.ui.form.on('Serial No Workflow', {
  before_submit: async function (form) {
    // Função executada antes do formulário ser submetido.
    await processSerialNumbers(form);  // Adiciona os números de série que faltam ao banco de dados.
  },
  checkbox_force_state: function (frm) {
    // Verifica se o usuário possui PELO MENOS UMA das roles permitidas usando .some()
    const userHasPermission = allowedRoles.some(role => frappe.boot.user.roles.includes(role));
    if (userHasPermission) {
      if (frm.doc.checkbox_force_state === 1) { // Se o checkbox está MARCADO
        is_force_state_allowed = true;
        frappe.show_alert({ message: __('Forçar estado do Workflow <b>HABILITADO</b>.'), indicator: 'green' });
      } else { // Se o checkbox está DESMARCADO
        is_force_state_allowed = false;
        frappe.show_alert({ message: __('Forçar estado do Workflow <b>DESABILITADO</b>.'), indicator: 'orange' });
      }
      console.log("is_force_state_allowed updated to:", is_force_state_allowed); // Log
    } else {
      // Garante que a flag seja falsa se o usuário não tiver a permissão.
      is_force_state_allowed = false;
      // Se um usuário sem permissão marcar a caixa (por algum motivo), desmarca
      // e informa o usuário.
      if (frm.doc.checkbox_force_state === 1) {
        frm.set_value('checkbox_force_state', 0); // Desmarca a caixa
        frappe.show_alert({ message: __('Você não tem permissão para forçar o estado do Workflow.'), indicator: 'red' });
      }
    }
  },
});

async function processSerialNumbers(form: FrappeForm<SerialNoWorkflow>) {
  // Carrega o documento do Workflow e obtém o estado inicial.
  const workflowDoc = await frappe.db.get_doc<Workflow>('Workflow', 'workflow_serial_no');
  const initialState = workflowDoc.states?.[0]?.state;
  if (!initialState) {
    frappe.throw('Estado inicial do Workflow não encontrado.');
  }

  // Filtra para incluir apenas serial numbers com is_valid = 1.
  // const successfulSerialNumbers = form.doc.serial_no_table.filter((row: any) => row.is_valid === 1);

  // Filtra para incluir apenas serial numbers possíveis de serem transicionados

  const outputsMap: Record<string, boolean> = {
    [OUTPUT_INFO_MESSAGE.SN_FOUND_ERP]: true,
    [OUTPUT_INFO_MESSAGE.SN_FOUND_GROWATT]: true,
    [OUTPUT_INFO_MESSAGE.INVALID_WORKFLOW_TRANSITION]: !!form.doc.checkbox_force_state,
  };

  const successfulSerialNumbers = form.doc.serial_no_table.filter(row => outputsMap[row.output_info]);
  const allSerialNumbers = successfulSerialNumbers.map((row: any) => row.serial_no);

  // Obtém os SNs que já existem no ERPNext.
  const existingRecords = await frappe.db.get_list('Serial No', {
    fields: ['name', 'workflow_state'],
    filters: { serial_no: ['in', allSerialNumbers] },
  });
  const existingSNSet = new Set(existingRecords.map((item: any) => item.name));

  // --- Pré-checagem de Transições ---
  // Esta etapa garante que todos os casos (novos e existentes) tenham uma transição válida,
  // evitando que a submissão seja concluída parcialmente.
  const operations: {
    sn: string;
    isNew: boolean;
    targetState: string;
  }[] = [];

  for (const snRow of successfulSerialNumbers) {
    if (!snRow.serial_no || !snRow.next_step) {
      console.warn("Dados incompletos para o SN:", snRow);
      frappe.msgprint(`❌ Dados incompletos para o SN ${snRow.serial_no}.`);
      throw "Processo abortado devido a dados incompletos.";
    }

    // Se current_workflow_state estiver vazio, utiliza o estado inicial do workflow.
    const currentState = snRow.current_workflow_state || initialState;
    let targetState;
    let isNew = false;

    if (!existingSNSet.has(snRow.serial_no)) {
      // Caso novo: forçamos o estado definido para a linha de SN
      isNew = true;
      targetState = snRow.next_step;
    } else {
      // Caso existente: tenta encontrar uma transição válida a partir do estado atual.
      const transition = workflowDoc.transitions.find(
        (t: any) => t.state === currentState && t.next_state === snRow.next_step
      );

      if (transition) {
        targetState = transition.next_state;
      } else if (is_force_state_allowed) {
        // Se o checkbox estiver ativo, força a transição usando o valor definido na linha.
        targetState = snRow.next_step;
      } else {
        // Caso não haja transição válida e a forçagem não esteja ativada, exibe os estados permitidos.
        const allowedStates = workflowDoc.transitions
          .filter((t: any) => t.state === currentState)
          .map((t: any) => t.next_state)
          .filter((value: any, index: number, self: any) => self.indexOf(value) === index);
        console.warn(`Transição não encontrada para SN existente ${snRow.serial_no}.`);
        frappe.msgprint(
          `❌ Transição de estado inválida para SN: ${snRow.serial_no}. Estado atual: ${currentState}, ` +
          `Próximo selecionado: ${snRow.next_step}. Permitidos: ${allowedStates.join(', ')}.`
        );
        throw "Processo abortado devido a transição inválida para SN existente.";
      }
    }
    // Armazena os detalhes da operação para execução posterior.
    operations.push({
      sn: snRow.serial_no,
      isNew: isNew,
      targetState: targetState,
    });
  }

  // --- Execução das Operações ---
  // Se todas as pré-checagens forem bem-sucedidas, cria ou atualiza os SNs.
  for (const op of operations) {
    if (op.isNew) {
      // Cria o novo SN com o estado inicial.
      try {
        const correspondingRow = successfulSerialNumbers.find((row: any) => row.serial_no === op.sn);
        const newSN = await frappe.db.insert({
          doctype: 'Serial No',
          serial_no: op.sn,
          item_code: correspondingRow?.item_code,
          item_name: correspondingRow?.item_name,
          company: correspondingRow?.company,
          workflow_state: initialState, // Cria com o estado padrão do sistema.
        });
        if (newSN) {
          frappe.msgprint(`✔️ Número de Série ${op.sn} foi adicionado com sucesso ao banco de dados.`);
          form.doc.serial_no_table.filter(child => child.serial_no === op.sn).forEach(child => child.is_success = 1), form.refresh_field('serial_no_table'); // Atualizar o is_success
          // Atualiza o workflow state usando ignore_workflow_validation como true para novos SNs.
          await agt.utils.update_workflow_state({
            doctype: "Serial No",
            docname: newSN.name,
            workflow_state: op.targetState,
            ignore_workflow_validation: true
          });
          console.log(`Workflow state atualizado para ${op.targetState} no novo SN ${op.sn}.`);
        }
      } catch (error) {
        console.error(`❌ Erro ao adicionar o número de série ${op.sn}:`, error);
        frappe.msgprint(`❌ Erro ao adicionar o número de série ${op.sn}.`);
        throw error;
      }
    } else {
      // Atualiza o workflow state para SNs já existentes, usando is_force_state_allowed conforme o flag.
      try {
        await agt.utils.update_workflow_state({
          doctype: 'Serial No',
          docname: op.sn,
          workflow_state: op.targetState,
          ignore_workflow_validation: !!form.doc.checkbox_force_state,
        });
        console.log(`Workflow state atualizado para ${op.targetState} no SN existente ${op.sn}.`);
      } catch (error) {
        console.error(`❌ Erro ao atualizar workflow state do SN ${op.sn}:`, error);
        frappe.msgprint(`❌ Falha ao atualizar workflow_state para ${op.targetState} no SN ${op.sn}.`);
        throw error;
      }
    }
  }
  // Atualiza a tabela do formulário após a conclusão de todas as operações.
  form.refresh_field('serial_no_table');
}